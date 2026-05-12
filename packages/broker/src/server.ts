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
   */
  bubbles?: Partial<Record<PetState, string | null>>;
  /** Default time-to-live (ms) for bubbles. Defaults to 2500. */
  bubbleTtlMs?: number;
  /**
   * Disable the mavis daemon permission poller (default: enabled).
   * Tests typically want to disable this so they don't try to fetch a daemon.
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
 * Default speech-bubble copy per state. Override via {@link BrokerOptions.bubbles}.
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

  // Wire state changes → broadcast (with optional speech bubble).
  // REVIEW is a sticky state — its bubble should NOT auto-dismiss while
  // it's active, so emit it without TTL (floater treats undefined ttl as
  // "stay until next state").
  machine.onChange((state, ts) => {
    const text = bubbles[state];
    if (!text) {
      hub.broadcastState(state, ts);
      return;
    }
    if (state === "review") {
      // Sticky bubble — no TTL. Floater will keep showing until the next
      // state push (typically Permission Resolved → state changes to whatever
      // comes next, which carries its own bubble or no bubble).
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

  // Start the mavis daemon perm poller (unless disabled, e.g. in tests).
  let permPoller: PermPoller | null = null;
  if (!opts.disablePermPoller) {
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
