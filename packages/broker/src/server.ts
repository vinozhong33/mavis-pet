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
import {
  createEventSource,
  type ActiveSession,
  type EventSourceHandle,
} from "./event-source.js";
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
   * Disable the mavis daemon permission poller.
   *
   * v0.4.2 — re-enabled by default. The endpoint moved to
   * `/mavis/api/permission/requests` (see perm-poller.ts) so the 404 spam
   * that justified disabling in v0.3.1 is gone. Set `disablePermPoller:
   * true` for unit tests that should not touch a real daemon.
   */
  disablePermPoller?: boolean;
  /** Override daemon URL for the perm poller. Default http://127.0.0.1:15321. */
  daemonUrl?: string;
  /** Perm poll interval in ms. Default 1500. */
  permPollIntervalMs?: number;
  /**
   * Disable the mavis daemon SSE event-source consumer.
   *
   * v0.4.2 — feeds active session pool (title + last message) for the
   * floater task card. Set `true` for unit tests that should not touch a
   * real daemon. Default `false` (enabled).
   */
  disableEventSource?: boolean;
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
  /** SSE event-source handle (null if disabled). */
  eventSource: EventSourceHandle | null;
  /** Graceful shutdown. */
  close(): Promise<void>;
}

/**
 * Default speech-bubble copy per state (legacy compact pill).
 * Used as fallback when no v0.4 card is configured for the state.
 * Override via {@link BrokerOptions.bubbles}.
 */
/**
 * v0.4.2 — legacy compact-pill copy. Deprecated; kept for `bubbles` opt
 * override capability. Empty defaults match the cards default — we don't
 * ship any stub copy out of the box (used to ship "oops"/"hey!"/etc which
 * looked random to the user when they didn't trigger an actual error).
 */
const DEFAULT_BUBBLES: Record<PetState, string | null> = {
  failed: null,
  review: null,
  jump: null,
  extra1: null,
  extra2: null,
  wave: null,
  run: null,
  idle: null,
};

/**
 * v0.4.2 — task-card config kept ONLY as a documentation/extension point.
 * The default copy ("Tool failed", "Got it" etc.) was actively misleading
 * (vino kept seeing "Tool failed" when no tool actually failed — failed
 * state degrades from any non-zero PostToolUse exit, but the stub label
 * suggests it's a real perm-blocking error). Keep the type for future
 * per-state customization, but ship empty defaults so the floater shows
 * NO card unless real SSE-driven session data is available.
 *
 * If you want a stub back for testing, override via {@link BrokerOptions.cards}.
 */
const DEFAULT_CARDS: Record<PetState, CardConfig | null> = {
  failed:  null,
  review:  null,
  jump:    null,
  extra1:  null,
  extra2:  null,
  wave:    null,
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

  // -------------------------------------------------------------------------
  // v0.4.2 — daemon SSE consumer (active session pool: title + lastMessage)
  //
  // Constructed up front so the onChange listener can read it; the actual
  // network connect happens in `start()` further down.
  // -------------------------------------------------------------------------
  let eventSource: EventSourceHandle | null = null;
  if (!opts.disableEventSource) {
    eventSource = createEventSource({
      clock,
      daemonUrl: opts.daemonUrl,
      logger,
      // v0.4.3 — when SSE updates a session's title / lastMessage,
      // re-broadcast the current state so the floater immediately picks up
      // the new card content. Without this hook, SSE data only reaches the
      // floater when an unrelated hook event happens to fire onChange.
      onSessionUpdate: () => {
        const state = machine.globalState;
        const ts = clock.now();
        broadcastForState(state, ts);
      },
      // v0.4.4 — primary perm-pending signal. Daemon emits `permission.ask`
      // on EventBus the moment a tool call hits a permission gate; we
      // forward it to the state machine immediately (~100ms latency,
      // was 1.5s via perm-poller). The poller is retained as a
      // `PermissionResolved` detector only (daemon doesn't emit a
      // corresponding `permission.resolved` event).
      onPermissionAsk: (sid) => {
        machine.ingest({ kind: "PermissionRequested", sessionId: sid });
      },
    });
  }

  // Wire state changes → broadcast.
  // v0.4.2 routing tree (in order of precedence):
  //   1. SSE-driven real session data → real title + lastMessage
  //   2. Static {@link cards} entry for this state → stub title/subtitle
  //   3. Legacy {@link bubbles} entry → compact pill text
  //   4. Plain state push (no card, no bubble)
  //
  // `loading` and `waiting` are derived purely from the state symbol now:
  //   - loading = state ∈ {run, jump}    (agent actively working)
  //   - waiting = state === review       (blocked on user perm)
  // These are mutually exclusive — review's loading is false because it's
  // semantically "not running, awaiting human"; the floater renders a clock
  // icon instead of a spinner when `waiting` is true.
  //
  // Sticky states (review) skip the auto-dismiss TTL.
  // Every push carries `activeSessionCount` for the collapsed-state badge.
  function broadcastForState(state: PetState, ts: number): void {
    const activeSessionCount = machine.activeSessionCount();
    const isLoading = state === "run" || state === "jump";
    const isWaiting = state === "review";
    const sticky = state === "review";

    // 1. Try SSE-driven real session data first.
    const sess = pickActiveSession(eventSource);
    if (sess && (sess.title || sess.displayName || sess.lastMessage || sess.currentAction)) {
      // v0.4.3 — title preference: real session.title > agent displayName.
      const cardTitle = sess.title || sess.displayName || "Working...";
      const isDone = sess.status === "finished";
      // v0.4.3 — subtitle priority: real lastMessage (streaming or final
      // assistant reply) > currentAction stub ("正在思考"). Show whatever
      // assistant text we have, even mid-stream — empty string only if
      // really nothing yet.
      const cardSubtitle = sess.lastMessage || sess.currentAction || "";
      hub.broadcastState(state, ts, {
        title: cardTitle,
        subtitle: cardSubtitle,
        loading: isLoading && !isDone,
        waiting: isWaiting,
        done: isDone,
        bubbleTtlMs: sticky ? undefined : bubbleTtlMs,
        activeSessionCount,
      });
      return;
    }

    // 2. Static card stub (default copy for transient states).
    const card = cards[state];
    if (card) {
      hub.broadcastState(state, ts, {
        title: card.title,
        subtitle: card.subtitle,
        loading: isLoading,
        waiting: isWaiting,
        bubbleTtlMs: sticky ? undefined : bubbleTtlMs,
        activeSessionCount,
      });
      return;
    }

    // 3. Legacy bubble fallback.
    const text = bubbles[state];
    if (!text) {
      // 4. Plain state — but we still ship loading/waiting/count so the
      // floater can render badge + icon without a card body.
      hub.broadcastState(state, ts, {
        loading: isLoading,
        waiting: isWaiting,
        activeSessionCount,
      });
      return;
    }
    if (sticky) {
      hub.broadcastState(state, ts, {
        bubble: text,
        waiting: true,
        activeSessionCount,
      });
    } else {
      hub.broadcastState(state, ts, {
        bubble: text,
        loading: isLoading,
        bubbleTtlMs,
        activeSessionCount,
      });
    }
  }
  machine.onChange((state, ts) => broadcastForState(state, ts));

  const handler = createHttpHandler({
    machine,
    broadcaster: hub,
    clock,
    recentEvents,
    petRef,
    startedAt,
    logger,
    // v0.4.3 — translate PreToolUse(tool) into a short Chinese verb describing
    // what the session is doing right now. Falls back to "正在思考" via
    // session.start; clears on session.finish.
    onHookEvent: (event) => {
      if (!eventSource) return;
      if (event.kind === "PreToolUse" && event.tool) {
        const action = toolActionLabel(event.tool);
        eventSource.markAction(event.sessionId, action);
      } else if (event.kind === "MessageComplete") {
        eventSource.markAction(event.sessionId, null);
      }
    },
    // v0.4.3 — floater POST /dismiss when user hovers/clicks a done card.
    // Evict the session immediately so the card disappears (vs the default
    // 5min lazy evict). Also stops any polling timer for that session.
    onDismissCard: () => {
      if (eventSource) eventSource.dismissCurrent();
    },
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

  // Start the mavis daemon perm poller. v0.4.2: re-enabled by default. The
  // endpoint moved to `/mavis/api/permission/requests` (was `/api/...` and
  // 404'd, hence the v0.3.1 disable). Pass `disablePermPoller: true` for
  // unit tests that should not touch a real daemon.
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

  // Kick off the SSE consumer now that the broker is otherwise ready.
  if (eventSource) {
    eventSource.start();
  }

  logger.info("broker_started", {
    host,
    port: address.port,
    pet: petRef.slug,
    permPoller: permPoller !== null,
    eventSource: eventSource !== null,
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
    eventSource,
    async close() {
      logger.info("broker_stopping");
      if (permPoller) permPoller.stop();
      if (eventSource) eventSource.stop();
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

/**
 * Pick the most-recently-touched active session from the SSE pool.
 *
 * Heuristic: when multiple sessions are running, the floater card has only
 * one slot, so we surface the one the user most recently saw activity from.
 * Returns `null` if no sessions or no event-source.
 */
function pickActiveSession(es: EventSourceHandle | null): ActiveSession | null {
  if (!es) return null;
  let best: ActiveSession | null = null;
  for (const s of es.getActiveSessions().values()) {
    // v0.4.3 — skip sessions flagged hidden (cron-triggered etc).
    if (s.hidden) continue;
    if (!best || s.lastTouchedAt > best.lastTouchedAt) best = s;
  }
  return best;
}

/**
 * v0.4.3 — map a tool name to a short Chinese verb describing what the
 * session is currently doing. Used by the broker's hook-event listener
 * (PreToolUse) to populate the floater card subtitle during a streaming
 * turn (replaces the empty "no message yet" gap with live status).
 *
 * Unknown tool → generic "调用工具中". Returning a stable Chinese label
 * keeps the floater card from flicker-changing on every tool swap.
 */
function toolActionLabel(tool: string): string {
  const t = tool.toLowerCase();
  if (t === "bash") return "执行命令";
  if (t === "webfetch" || t === "fetch") return "查阅资料";
  if (t === "read") return "读取文件";
  if (t === "write") return "编辑文件";
  if (t === "edit") return "修改代码";
  if (t === "grep" || t === "glob") return "搜索代码";
  if (t === "task" || t === "spawn") return "派发任务";
  if (t.startsWith("mavis_") || t.startsWith("mcp_")) return "调用工具";
  return "调用工具";
}
