/**
 * Pet Broker — daemon SSE consumer (v0.6).
 *
 * v0.6 PIVOT: subscribes to the new `session.status_update` SSE event
 * (https://gitlab.xaminim.com/matrix/agent-archon!1748) which exposes the
 * full per-turn live phase (thinking / calling_tool / streaming_text /
 * waiting_perm / done) inline. This replaces the previous Frankenstein
 * stack that combined:
 *
 *   - `permission.ask` SSE       → perm-pending detection
 *   - 1.5s message polling       → lastMessage streaming preview
 *   - PreToolUse hook → broker   → currentAction tool-name display
 *   - 5s perm-poller diff        → perm-resolved detection
 *
 * v0.6 broker: subscribe `session.status_update`, switch on `phase`, render.
 * Net cuts ~250 LOC of glue, removes per-session HTTP polling, and lifts
 * latency from ~1.5s to <200ms.
 *
 * Compatibility: REQUIRES daemon with `session.status_update` event
 * (https://gitlab.xaminim.com/matrix/agent-archon!1748 merged 2026-05-14).
 * Older daemons emit only lifecycle events — broker will receive
 * session.start / session.finish but no thinking/calling_tool/streaming_text
 * signals, so the floater card title shows but subtitle stays empty.
 * Users on old daemon should stay on mavis-pet v0.4.4.
 */

import type { Clock, TimerHandle } from "./clock.js";
import type { Logger } from "./logger.js";
import type { SessionCard } from "./types.js";

const DEFAULT_DAEMON_URL =
  process.env.MAVIS_DAEMON_URL ?? "http://127.0.0.1:15321";

/** Subset of session info we cache for the floater task card. */
export interface ActiveSession {
  sessionId: string;
  /** Cached from `/mavis/api/session/<sid>` after first session.start event. */
  title?: string;
  /** Agent display name (e.g. "mavis健康") — fallback when title is empty. */
  displayName?: string;
  /** Latest streaming preview / final reply preview (≤ 80 chars). */
  lastMessage?: string;
  /** Last known status: 'started' | 'finished' | other. */
  status?: string;
  /** ms ts of the last event that touched this session. */
  lastTouchedAt: number;
  /** v0.6.1 — ms ts when status flipped to 'finished' (drives 30s evict). */
  finishedAt?: number;
  /** When non-null, an evict timer scheduled for this session. */
  evictTimer?: TimerHandle | null;
  /**
   * True for cron-triggered sessions (purpose starts with 'cron:').
   * The floater hides these from the task card.
   */
  hidden?: boolean;
  /**
   * Short Chinese verb describing what the session is currently doing.
   * Sourced from `session.status_update` phase:
   *   - thinking → "正在思考"
   *   - calling_tool → "正在使用 <tool 中文名>"
   *   - streaming_text / done → undefined (subtitle uses lastMessage instead)
   *   - waiting_perm → "等待审批"
   */
  currentAction?: string;
}

export interface EventSourceOptions {
  clock: Clock;
  /** Daemon URL (no trailing slash, no /mavis suffix). */
  daemonUrl?: string;
  logger?: Logger;
  /** Inject a custom fetch impl for tests. */
  fetchImpl?: typeof fetch;
  /**
   * ms to wait after a session goes 'finished' before evicting it from the
   * pool. v0.6.1 default 30_000 (30s) — gives the user 30s to glance at the
   * "done" card before it fades. Set to 0 to disable auto-evict (sticky
   * until /dismiss POST).
   */
  evictAfterMs?: number;
  /** Initial reconnect backoff ms. Default 500. */
  initialBackoffMs?: number;
  /** Max reconnect backoff ms. Default 30000. */
  maxBackoffMs?: number;
  /** Max chars for `lastMessage` (truncated). Default 80. */
  maxMessageChars?: number;
  /**
   * Fired whenever a session's title / lastMessage / status changes so the
   * server can re-broadcast a fresh WS state message. Pass null in tests.
   */
  onSessionUpdate?: () => void;
  /**
   * v0.6 — fired when daemon emits `session.status_update phase=waiting_perm`.
   * Server wires this to `machine.ingest({kind:"PermissionRequested",sessionId})`.
   */
  onPermissionRequested?: (sessionId: string, requestId?: string) => void;
  /**
   * v0.6 — fired when an active perm wait should be considered resolved.
   * Triggered by `phase=calling_tool` (tool started → perm allowed) and
   * `phase=done` (turn ended → any pending perm resolved one way or another).
   * Server wires this to `machine.ingest({kind:"PermissionResolved",sessionId})`.
   */
  onPermissionResolved?: (sessionId: string) => void;
  /**
   * v0.6.1 — pre-built deeplink template fed into each SessionCard.
   * Format: `<scheme>://<action>?<param>={SID}` where {SID} is replaced
   * with the actual sessionId. Example: `minimax-cn-test://chat?chat_id={SID}`.
   * When undefined, SessionCard.deeplink is omitted and the floater
   * falls back to `open -a` focus only.
   */
  deeplinkTemplate?: string;
}

export interface EventSourceHandle {
  start(): void;
  stop(): void;
  getActiveSessions(): Map<string, ActiveSession>;
  /**
   * v0.6.1 — return all visible (non-hidden) sessions as SessionCard[]
   * sorted by `lastEventTs` descending (most recent on top). Used by the
   * server to broadcast `{type:"sessions"}` WS messages.
   */
  getSessionCards(): SessionCard[];
  activeCount(): number;
  /**
   * Explicitly evict the session whose card the floater just dismissed
   * (POST /dismiss). Pass null to evict the most-recently-touched
   * non-hidden session.
   */
  dismissCurrent(sessionId: string | null): void;
  /** Wait for in-flight handlers to settle (test helper). */
  whenIdle(): Promise<void>;
}

/** Map daemon tool name → short Chinese verb for currentAction. */
function toolNameZh(tool: string | undefined): string | undefined {
  if (!tool) return undefined;
  const map: Record<string, string> = {
    bash: "执行命令",
    read: "读取文件",
    write: "写入文件",
    edit: "编辑文件",
    glob: "查找文件",
    grep: "搜索代码",
    webfetch: "查阅网页",
    web_search: "搜索网络",
    task: "调度子任务",
    todowrite: "更新任务列表",
    skill: "加载技能",
    mavis_communication_send: "向其他 session 发消息",
  };
  return map[tool.toLowerCase()] ?? `调用 ${tool}`;
}

export function createEventSource(opts: EventSourceOptions): EventSourceHandle {
  const baseUrl = opts.daemonUrl ?? DEFAULT_DAEMON_URL;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const evictAfterMs = opts.evictAfterMs ?? 30_000;
  const initialBackoffMs = opts.initialBackoffMs ?? 500;
  const maxBackoffMs = opts.maxBackoffMs ?? 30_000;
  const maxMessageChars = opts.maxMessageChars ?? 80;
  const log = opts.logger;
  const onSessionUpdate = opts.onSessionUpdate;
  const deeplinkTemplate = opts.deeplinkTemplate;

  const sessions = new Map<string, ActiveSession>();
  let abortController: AbortController | null = null;
  let stopped = false;
  let started = false;
  let backoff = initialBackoffMs;
  let pendingHandlers = 0;
  let idleResolvers: Array<() => void> = [];

  function bumpHandler(): void {
    pendingHandlers++;
  }
  function settleHandler(): void {
    pendingHandlers--;
    if (pendingHandlers === 0 && idleResolvers.length) {
      const fns = idleResolvers;
      idleResolvers = [];
      for (const fn of fns) fn();
    }
  }

  // -------------------------------------------------------------------------
  // HTTP helpers — title / displayName lookup (no message polling in v0.6).
  // -------------------------------------------------------------------------

  async function fetchSessionTitle(
    sid: string,
  ): Promise<{ title?: string; displayName?: string } | undefined> {
    try {
      const r = await fetchImpl(`${baseUrl}/mavis/api/session/${sid}`);
      if (!r.ok) return undefined;
      const j = (await r.json()) as { session?: { title?: string; displayName?: string; agentName?: string } };
      const s = j?.session ?? undefined;
      if (!s) return undefined;
      return { title: s.title, displayName: s.displayName ?? s.agentName };
    } catch {
      return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Per-event handlers.
  // -------------------------------------------------------------------------

  function ensureSession(sid: string, now: number): ActiveSession {
    let s = sessions.get(sid);
    if (!s) {
      s = { sessionId: sid, lastTouchedAt: now };
      sessions.set(sid, s);
    }
    return s;
  }

  function cancelEvict(s: ActiveSession): void {
    if (s.evictTimer) {
      opts.clock.clearTimeout(s.evictTimer);
      s.evictTimer = null;
    }
    s.finishedAt = undefined;
  }

  function scheduleEvict(s: ActiveSession): void {
    cancelEvict(s);
    s.finishedAt = opts.clock.now();
    if (evictAfterMs <= 0) return; // sticky — wait for /dismiss
    s.evictTimer = opts.clock.setTimeout(() => {
      sessions.delete(s.sessionId);
      onSessionUpdate?.();
    }, evictAfterMs);
  }

  function truncate(s: string, max: number): string {
    const flat = s.replace(/\s+/g, " ").trim();
    if (flat.length <= max) return flat;
    return flat.slice(0, max - 1) + "…";
  }

  async function handleEvent(name: string, data: unknown): Promise<void> {
    // Filter high-frequency noise: fs.* / system.* / config.* / heartbeat.
    if (
      name.startsWith("fs.") ||
      name.startsWith("system.") ||
      name.startsWith("config.") ||
      name === "heartbeat"
    ) {
      return;
    }

    const sid = extractSessionId(data);
    if (!sid) {
      log?.debug("event_source_event_no_sid", { name });
      return;
    }
    const now = opts.clock.now();
    const sess = ensureSession(sid, now);
    sess.lastTouchedAt = now;

    switch (name) {
      case "session.created": {
        // Flag cron-triggered sessions as hidden so they don't surface on the floater card.
        const payload =
          (data && typeof data === "object" && (data as { payload?: unknown }).payload) || {};
        const purpose =
          payload && typeof payload === "object"
            ? (payload as { purpose?: unknown }).purpose
            : undefined;
        if (typeof purpose === "string" && purpose.startsWith("cron:")) {
          sess.hidden = true;
        }
        if (!sess.title || !sess.displayName) {
          const info = await fetchSessionTitle(sid);
          if (info?.title && !sess.title) sess.title = info.title;
          if (info?.displayName && !sess.displayName) sess.displayName = info.displayName;
        }
        break;
      }

      case "session.start": {
        // Lifecycle marker — set status; live status fields come from
        // `session.status_update` events that follow.
        sess.status = "started";
        cancelEvict(sess);
        if (!sess.title || !sess.displayName) {
          const info = await fetchSessionTitle(sid);
          if (info?.title && !sess.title) sess.title = info.title;
          if (info?.displayName && !sess.displayName) sess.displayName = info.displayName;
        }
        break;
      }

      case "session.finish": {
        // Lifecycle marker — set status; the matching `session.status_update
        // phase=done` event is the source of truth for finalMessage.
        sess.status = "finished";
        sess.currentAction = undefined;
        scheduleEvict(sess);
        break;
      }

      case "session.title_updated": {
        const t = extractTitleFromPayload(data);
        if (t) sess.title = t;
        break;
      }

      case "session.compressed":
      case "session.deleted":
      case "session.abort": {
        sessions.delete(sid);
        break;
      }

      case "session.status_update": {
        // v0.6 main path — daemon-pushed live phase signal.
        const payload = extractPayload(data);
        const phase = (payload as { phase?: string })?.phase;
        log?.debug("status_update_received", {
          sid,
          phase,
          tool: (payload as { tool?: string }).tool,
        });
        switch (phase) {
          case "thinking": {
            // Turn started; no tool/text yet. Clear lastMessage so the
            // floater stops showing the previous turn's done text while
            // we wait for the new turn's first chunk.
            sess.status = "started";
            sess.currentAction = "正在思考";
            sess.lastMessage = undefined;
            cancelEvict(sess);
            break;
          }
          case "calling_tool": {
            sess.status = "started";
            cancelEvict(sess); // back to active — drop any pending evict
            const tool = (payload as { tool?: string }).tool;
            sess.currentAction = toolNameZh(tool) ?? "正在调用工具";
            // calling_tool implies any pending perm was just allow'd
            // (deny path doesn't fire PreToolUse).
            opts.onPermissionResolved?.(sid);
            break;
          }
          case "streaming_text": {
            sess.status = "started";
            cancelEvict(sess); // back to active — drop any pending evict
            // Real assistant text is now flowing — drop the "正在思考" stub.
            sess.currentAction = undefined;
            const preview = (payload as { textPreview?: string }).textPreview;
            if (typeof preview === "string" && preview.trim()) {
              sess.lastMessage = truncate(preview, maxMessageChars);
            }
            break;
          }
          case "waiting_perm": {
            // Floater enters review state via the state machine; the card
            // subtitle gets a "等待审批" cue while there.
            cancelEvict(sess); // active again, blocked on user
            sess.currentAction = "等待审批";
            const reqId = (payload as { permRequestId?: string }).permRequestId;
            opts.onPermissionRequested?.(sid, reqId);
            break;
          }
          case "done": {
            sess.status = "finished";
            sess.currentAction = undefined;
            const finalMsg = (payload as { finalMessage?: string }).finalMessage;
            if (typeof finalMsg === "string" && finalMsg.trim()) {
              sess.lastMessage = truncate(finalMsg, maxMessageChars);
            }
            // Turn end implies any pending perm resolved one way or the other.
            opts.onPermissionResolved?.(sid);
            scheduleEvict(sess);
            break;
          }
          default: {
            log?.debug("event_source_unknown_status_phase", { name, phase });
          }
        }
        break;
      }

      default: {
        log?.debug("event_source_unknown_event", { name });
      }
    }

    // Re-broadcast on every event so the floater always picks up the latest
    // session-record snapshot.
    try {
      onSessionUpdate?.();
    } catch {
      /* ignore */
    }
  }

  // -------------------------------------------------------------------------
  // Payload helpers.
  // -------------------------------------------------------------------------

  function extractPayload(data: unknown): unknown {
    if (!data || typeof data !== "object") return undefined;
    return (data as { payload?: unknown }).payload;
  }

  function extractSessionId(data: unknown): string | undefined {
    const payload = extractPayload(data);
    if (payload && typeof payload === "object") {
      const sid = (payload as { sessionId?: unknown }).sessionId;
      if (typeof sid === "string" && sid) return sid;
    }
    if (data && typeof data === "object") {
      const sid = (data as { sessionId?: unknown }).sessionId;
      if (typeof sid === "string" && sid) return sid;
    }
    return undefined;
  }

  function extractTitleFromPayload(data: unknown): string | undefined {
    const payload = extractPayload(data);
    if (payload && typeof payload === "object") {
      const t = (payload as { title?: unknown }).title;
      if (typeof t === "string" && t.trim()) return t;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // SSE consumer loop.
  // -------------------------------------------------------------------------

  async function consume(): Promise<void> {
    while (!stopped) {
      abortController = new AbortController();
      const url = `${baseUrl}/mavis/api/events`;
      log?.info("event_source_starting", { url });
      try {
        const response = await fetchImpl(url, {
          headers: { accept: "text/event-stream" },
          signal: abortController.signal,
        });
        if (!response.ok || !response.body) {
          log?.warn("event_source_http_error", { status: response.status });
          await backoffDelay();
          continue;
        }
        log?.info("event_source_connected", { url });
        backoff = initialBackoffMs;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let currentEvent = "message";
        let currentData = "";
        while (!stopped) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nlIdx;
          while ((nlIdx = buf.indexOf("\n")) >= 0) {
            let line = buf.slice(0, nlIdx);
            buf = buf.slice(nlIdx + 1);
            if (line.endsWith("\r")) line = line.slice(0, -1);
            if (line === "") {
              // Dispatch event.
              if (currentData) {
                let parsed: unknown = currentData;
                try {
                  parsed = JSON.parse(currentData);
                } catch {
                  /* keep raw */
                }
                bumpHandler();
                handleEvent(currentEvent, parsed)
                  .catch((err) => log?.warn("event_source_handler_error", { name: currentEvent, err: (err as Error).message }))
                  .finally(() => settleHandler());
              }
              currentEvent = "message";
              currentData = "";
              continue;
            }
            if (line.startsWith(":")) continue; // comment
            if (line.startsWith("event:")) {
              currentEvent = line.slice(6).trim();
              continue;
            }
            if (line.startsWith("data:")) {
              currentData += line.slice(5).trimStart();
              continue;
            }
            // unknown field — ignore
          }
        }
      } catch (err) {
        if (!stopped) {
          log?.warn("event_source_loop_error", { err: (err as Error).message });
        }
      }
      if (!stopped) await backoffDelay();
    }
  }

  async function backoffDelay(): Promise<void> {
    await new Promise<void>((resolve) => {
      opts.clock.setTimeout(() => resolve(), backoff);
    });
    backoff = Math.min(backoff * 2, maxBackoffMs);
  }

  return {
    start(): void {
      if (stopped) return;
      if (started) return;
      started = true;
      void consume();
    },
    stop(): void {
      stopped = true;
      if (abortController) {
        try {
          abortController.abort();
        } catch {
          /* ignore */
        }
      }
      // Clear any in-flight evict timers so close() doesn't leave orphaned
      // setTimeout handles (matters in tests using FakeClock + vitest).
      for (const s of sessions.values()) {
        if (s.evictTimer) opts.clock.clearTimeout(s.evictTimer);
        s.evictTimer = null;
      }
      log?.info("event_source_stopped");
    },
    getActiveSessions(): Map<string, ActiveSession> {
      return new Map(sessions);
    },
    getSessionCards(): SessionCard[] {
      // Convert internal ActiveSession map to public SessionCard[],
      // skip cron-flagged hidden sessions, sort by lastEventTs descending
      // (most recent activity on top of the floater's vertical stack).
      const out: SessionCard[] = [];
      for (const s of sessions.values()) {
        if (s.hidden) continue;
        const card: SessionCard = {
          sessionId: s.sessionId,
          status: s.status === "finished" ? "finished" : "started",
          lastEventTs: s.lastTouchedAt,
        };
        if (s.title) card.title = s.title;
        if (s.displayName) card.agentName = s.displayName;
        if (s.currentAction) card.currentAction = s.currentAction;
        if (s.lastMessage) card.lastMessage = s.lastMessage;
        if (s.finishedAt !== undefined) card.finishedAt = s.finishedAt;
        if (deeplinkTemplate) {
          card.deeplink = deeplinkTemplate.replace(
            /\{SID\}/g,
            encodeURIComponent(s.sessionId),
          );
        }
        out.push(card);
      }
      out.sort((a, b) => b.lastEventTs - a.lastEventTs);
      return out;
    },
    activeCount(): number {
      return sessions.size;
    },
    dismissCurrent(sessionId: string | null): void {
      if (sessionId) {
        const s = sessions.get(sessionId);
        if (s?.evictTimer) opts.clock.clearTimeout(s.evictTimer);
        sessions.delete(sessionId);
      } else {
        // Drop the most-recently-touched non-hidden session.
        let best: ActiveSession | undefined;
        for (const s of sessions.values()) {
          if (s.hidden) continue;
          if (!best || s.lastTouchedAt > best.lastTouchedAt) best = s;
        }
        if (best) {
          if (best.evictTimer) opts.clock.clearTimeout(best.evictTimer);
          sessions.delete(best.sessionId);
        }
      }
      onSessionUpdate?.();
    },
    whenIdle(): Promise<void> {
      if (pendingHandlers === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        idleResolvers.push(resolve);
      });
    },
  };
}
