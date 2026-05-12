/**
 * Broker server bootstrap — wires StateMachine + HTTP + WS + perm poller together.
 *
 * Public entry: {@link startBroker} returns a {@link BrokerHandle} for tests
 * and lifecycle management. The CLI in `src/main.ts` is a thin wrapper.
 */

import { WebSocketServer } from "ws";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { type Clock, RealClock } from "./clock.js";
import { createHttpHandler, startHttpServer } from "./http.js";
import { type Logger, createLogger } from "./logger.js";
import { StateMachine } from "./state-machine.js";
import { WsHub } from "./ws.js";
import { type PermPoller, startPermPoller } from "./perm-poller.js";
import type { HookEvent, PetState } from "./types.js";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 7857;

/**
 * v0.4 task-card config — populates the bubble card the floater renders.
 *
 * - `title` (required) — bold one-line task title (ellipsised in the card).
 * - `subtitle` (optional) — light two-line description (ellipsised at line 2).
 * - `loading` (optional) — when true, floater shows a spinner in the card's
 *   top-right; means "agent is working / waiting on something".
 */
export interface CardConfig {
  title: string;
  subtitle?: string;
  loading?: boolean;
}

export interface BrokerOptions {
  host?: string;
  port?: number;
  /** Initial pet slug, exposed in /status and emitted on WS connect. */
  pet?: string | null;
  /** Inject a clock (for tests). Defaults to RealClock. */
  clock?: Clock;
  /** Inject a logger. Defaults to stderr logger. */
  logger?: Logger;
  /** State machine knobs for tests / advanced configs. */
  failedDegradeMs?: number;
  waveDurationMs?: number;
  jumpDurationMs?: number;
  bootDurationMs?: number;
  idleAfterMs?: number;
  /**
   * Override / extend default speech bubbles. Keys are PetState; values are
   * either a short string or `null` to suppress the bubble for that state.
   *
   * Legacy compact-pill mode. New code should prefer {@link cards}; this is
   * kept for back-compat and one-liner overrides.
   */
  bubbles?: Partial<Record<PetState, string | null>>;
  /**
   * v0.4 task-card config per state. Each entry can supply title (bold one
   * liner), subtitle (light two-line description), and loading (spinner).
   * Set entry to `null` to suppress the card for that state. When a card is
   * present for a state, it takes precedence over {@link bubbles}.
   *
   * Default cards are defined for transient overlay states (jump / wave /
   * extra1 / extra2 / failed / review). Idle and run intentionally have no
   * default card — they need real session data (title, latest message)
   * supplied by the SSE module in v0.4.1+.
   */
  cards?: Partial<Record<PetState, CardConfig | null>>;
  /** Default time-to-live (ms) for bubbles. Defaults to 2500. */
  bubbleTtlMs?: number;
  /**
   * Disable the mavis daemon permission poller (default: **disabled** as of
   * v0.3.1 — the daemon's `/api/permission/requests` endpoint disappeared
   * after a daemon refactor and we'd just spam the log with 404s. Set to
   * `false` explicitly when the endpoint comes back, or override `daemonUrl`).
   */
  disablePermPoller?: boolean;
  /** Override daemon URL for the perm poller. Default http://127.0.0.1:15321. */
  daemonUrl?: string;
  /** Perm poll interval in ms. Default 1500. */
  permPollIntervalMs?: number;
}

export interface BrokerHandle {
  host: string;
  port: number;
  /** Resolved port (if 0 was passed, this is the OS-assigned port). */
  address: AddressInfo;
  machine: StateMachine;
  hub: WsHub;
  http: HttpServer;
  wss: WebSocketServer;
  /** Perm poller handle (null if disabled). */
  permPoller: PermPoller | null;
  /** Graceful shutdown. */
  close(): Promise<void>;
}

/**
 * Default speech-bubble copy per state (legacy compact pill).
 * Used as fallback when no v0.4 card is configured for the state.
 * Override via {@link BrokerOptions.bubbles}.
 */
const DEFAULT_BUBBLES: Record<PetState, string | null> = {
  failed: "oops",
  review: "等你 allow",
  jump: "hey!",
  extra1: "morning",
  extra2: "bye",
  wave: "done!",
  run: null,
  idle: null,
};

/**
 * v0.4 task-card config (per state). Stub copy until the SSE module in
 * v0.4.1+ supplies real session title + latest assistant message.
 *
 * Idle and run intentionally remain `null` — they want real data, not
 * stub text. Until the SSE pipeline lands, idle/run keep going through
 * the legacy bubble path (which is also null for those two states, so
 * the floater shows nothing — same as v0.3).
 */
const DEFAULT_CARDS: Record<PetState, CardConfig | null> = {
  failed:  { title: "Tool failed", subtitle: "检查输出 / 查日志", loading: false },
  review:  { title: "Permission needed", subtitle: "等你 allow", loading: true },
  jump:    { title: "Got it", subtitle: "开始处理...", loading: true },
  extra1:  { title: "Hello", subtitle: "新会话开始", loading: false },
  extra2:  { title: "See ya", subtitle: "会话结束", loading: false },
  wave:    { title: "Done", subtitle: "完成 ✓", loading: false },
  run:     null,
  idle:    null,
};

export async function startBroker(opts: BrokerOptions = {}): Promise<BrokerHandle> {
  const host = opts.host ?? DEFAULT_HOST;
  const port = opts.port ?? DEFAULT_PORT;
  const clock = opts.clock ?? new RealClock();
  const logger = opts.logger ?? createLogger({ level: "info" });

  const machine = new StateMachine({
    clock,
    failedDegradeMs: opts.failedDegradeMs,
    waveDurationMs: opts.waveDurationMs,
    jumpDurationMs: opts.jumpDurationMs,
    bootDurationMs: opts.bootDurationMs,
    idleAfterMs: opts.idleAfterMs,
  });

  const petRef = { slug: opts.pet ?? null };
  const recentEvents: HookEvent[] = [];
  const startedAt = clock.now();

  const bubbles: Record<PetState, string | null> = {
    ...DEFAULT_BUBBLES,
    ...(opts.bubbles ?? {}),
  };
  const cards: Record<PetState, CardConfig | null> = {
    ...DEFAULT_CARDS,
    ...(opts.cards ?? {}),
  };
  const bubbleTtlMs = opts.bubbleTtlMs ?? 2_500;

  const hub = new WsHub({
    clock,
    logger,
    getCurrentState: () => ({
      state: machine.globalState,
      ts: machine.lastChangeAt,
    }),
    getCurrentPet: () => petRef.slug,
  });

  // Wire state changes → broadcast.
  // Routing priority:
  //   1. cards[state] present → emit v0.4 task-card (title + subtitle + loading)
  //   2. else bubbles[state]  → emit legacy compact pill
  //   3. else                  → plain state push (no bubble)
  // Sticky states (review) skip auto-dismiss TTL — bubble stays until next push.
  machine.onChange((state, ts) => {
    const card = cards[state];
    if (card) {
      const sticky = state === "review";
      hub.broadcastState(state, ts, {
        title: card.title,
        subtitle: card.subtitle,
        loading: card.loading,
        bubbleTtlMs: sticky ? undefined : bubbleTtlMs,
      });
      return;
    }
    const text = bubbles[state];
    if (!text) {
      hub.broadcastState(state, ts);
      return;
    }
    if (state === "review") {
      hub.broadcastState(state, ts, { bubble: text });
    } else {
      hub.broadcastState(state, ts, { bubble: text, bubbleTtlMs });
    }
  });

  const handler = createHttpHandler({
    machine,
    broadcaster: hub,
    clock,
    recentEvents,
    petRef,
    startedAt,
    logger,
  });

  const { server: http, address } = await startHttpServer(handler, host, port);

  // Attach WS to the same HTTP server, mounted at /ws.
  const wss = new WebSocketServer({ noServer: true });
  hub.attach(wss);

  http.on("upgrade", (req, socket, head) => {
    const url = req.url ?? "/";
    if (url === "/ws" || url === "/") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  // Start the mavis daemon perm poller. Default DISABLED in v0.3.1 because
  // the daemon's `/api/permission/requests` endpoint vanished after a daemon
  // refactor (returns 404). Pass `disablePermPoller: false` explicitly to
  // re-enable when the endpoint comes back (or override `daemonUrl`).
  let permPoller: PermPoller | null = null;
  if (opts.disablePermPoller === false) {
    permPoller = startPermPoller({
      clock,
      machine,
      daemonUrl: opts.daemonUrl,
      intervalMs: opts.permPollIntervalMs,
      logger,
    });
  }

  logger.info("broker_started", {
    host,
    port: address.port,
    pet: petRef.slug,
    permPoller: permPoller !== null,
  });

  return {
    host,
    port: address.port,
    address,
    machine,
    hub,
    http,
    wss,
    permPoller,
    async close() {
      logger.info("broker_stopping");
      if (permPoller) permPoller.stop();
      hub.closeAll();
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      await new Promise<void>((resolve, reject) => {
        http.close((err) => (err ? reject(err) : resolve()));
      });
      machine.dispose();
      logger.info("broker_stopped");
    },
  };
}
