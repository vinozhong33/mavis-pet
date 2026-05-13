/**
 * Pet Broker — mavis daemon SSE consumer.
 *
 * v0.4.2 — replaces the v0.3 polling-only pipeline with a real-time push
 * channel sourced from the daemon's `GET /mavis/api/events` endpoint. SSE
 * gives us the missing pieces the perm-poller can't provide:
 *   - active session pool (which sessions are currently running, with title)
 *   - real-time message text (for the floater task-card subtitle)
 *
 * The state machine still owns "what state should the pet be in" (driven by
 * hook events posted to /event from the mavis hook payloads). This module
 * only feeds **side-channel display data** (title + last message) into a pool
 * the server.ts reads at broadcast time.
 *
 * Why we don't use the browser EventSource API:
 *   - Node 18+ has it, but typings/headers control is awkward.
 *   - We want a tiny, dependency-free SSE parser we can unit-test.
 *
 * Wire protocol (assumed daemon SSE shape, based on user-memory note
 * "GET /mavis/api/events — run_status_changed / message_update / message_end /
 * session.new etc."):
 *
 *   event: run_status_changed
 *   data: {"sessionId":"ses_xxx","status":"started"}
 *
 *   event: message_update
 *   data: {"sessionId":"ses_xxx","content":"...","role":"assistant"}
 *
 *   event: message_end
 *   data: {"sessionId":"ses_xxx","content":"..."}
 *
 *   event: session.new
 *   data: {"sessionId":"ses_xxx"}
 *
 * If real daemon fields differ, all extraction is defensive (typeof checks +
 * fallback chain) and unknown events are debug-logged, not fatal.
 */

import type { Clock, TimerHandle } from "./clock.js";
import type { Logger } from "./logger.js";

const DEFAULT_DAEMON_URL =
  process.env.MAVIS_DAEMON_URL ?? "http://127.0.0.1:15321";

/** Subset of session info we cache for the floater task card. */
export interface ActiveSession {
  sessionId: string;
  /** Cached from `/mavis/api/session/<sid>` after first 'started' event. */
  title?: string;
  /**
   * v0.4.3 — Cached agent display name from `/mavis/api/session/<sid>`
   * (`displayName` field, fallback to `agentName`). Used as fallback when
   * `title` is empty (e.g. agent root session that hasn't been named by
   * the LLM yet — surface "mavis健康" instead of empty title).
   */
  displayName?: string;
  /** Cached from `/mavis/api/session/<sid>/message?limit=1` (≤ 80 chars). */
  lastMessage?: string;
  /** Last known SSE status: 'started' | 'finished' | other (raw). */
  status?: string;
  /** ms ts of the last event that touched this session. */
  lastTouchedAt: number;
  /** When non-null, an evict timer scheduled for this session. */
  evictTimer?: TimerHandle | null;
  /**
   * v0.4.3 — true for cron-triggered sessions (purpose starts with 'cron:').
   * The floater hides these from the task card; vino only cares about
   * sessions they themselves prompted.
   */
  hidden?: boolean;
  /**
   * v0.4.3 — short Chinese verb describing what the session is currently
   * doing during a streaming turn. Updated by the broker when it observes
   * PreToolUse hook events ("执行命令" for bash, "搜索代码" for grep, etc.).
   * Cleared on session.finish so the card switches to the real lastMessage.
   * When set, the floater shows this string as subtitle instead of
   * lastMessage — semantically "live status" vs "final reply preview".
   */
  currentAction?: string;
  /**
   * v0.4.3 — interval handle for the lastMessage poller running while
   * status === "started". Polls daemon every 1.5s so the floater card
   * subtitle reflects live streaming output. Cleared on session.finish.
   */
  pollTimer?: TimerHandle | null;
  /**
   * v0.4.4 — minimum daemon-message timestamp to accept into `lastMessage`.
   * Set to `clock.now()` on every session.start so the polling loop's
   * first fetch (which races against the daemon producing the new turn's
   * first assistant chunk) doesn't pull the previous turn's final reply
   * back in and reanimate stale "done" text on the card. Once a fresh
   * assistant chunk lands (timestamp > this), it overwrites lastMessage
   * normally.
   */
  lastTurnStartTimestamp?: number;
}

export interface EventSourceOptions {
  clock: Clock;
  /** Daemon URL, e.g. http://127.0.0.1:15321. Default reads MAVIS_DAEMON_URL. */
  daemonUrl?: string;
  logger?: Logger;
  /**
   * Inject a custom fetch impl for tests. Default: global `fetch`. The fetch
   * must support AbortSignal and return a streaming Response with body.
   */
  fetchImpl?: typeof fetch;
  /**
   * ms to wait after a session goes 'finished' before evicting it from the
   * pool. Default 5 minutes — gives the floater time to keep showing the
   * "done!" card briefly even after the session ends.
   */
  evictAfterMs?: number;
  /** Initial reconnect backoff ms. Default 500. */
  initialBackoffMs?: number;
  /** Max reconnect backoff ms. Default 30000. */
  maxBackoffMs?: number;
  /** Max chars for `lastMessage` (truncated). Default 80. */
  maxMessageChars?: number;
  /**
   * v0.4.3 — fired whenever a session's title / lastMessage / status changes.
   * broker uses this to push a fresh WS state message even when the broker
   * state machine itself didn't transition (SSE is a side channel that
   * doesn't go through hook events). Pass null to disable (e.g. tests).
   */
  onSessionUpdate?: () => void;
  /**
   * v0.4.4 — fired when daemon emits `permission.ask` SSE event for a
   * session, replacing the old 1.5s perm-poller as the primary "perm
   * pending" signal source. Server wires this to
   * `machine.ingest({kind: "PermissionRequested", sessionId})`. The
   * perm-poller is retained only as a `PermissionResolved` detector
   * (daemon does NOT emit a corresponding `permission.resolved` event,
   * so we still need to diff the pending list to learn when an ask is
   * answered). Pass null to disable (e.g. tests).
   */
  onPermissionAsk?: (sessionId: string, requestId?: string) => void;
}

export interface EventSourceHandle {
  /** Open SSE connection (and start reconnect loop). Idempotent if already started. */
  start(): void;
  /** Stop SSE consumer; closes the inflight stream. Idempotent. */
  stop(): void;
  /** Snapshot of currently-tracked sessions. Returns a new Map (caller mutation safe). */
  getActiveSessions(): Map<string, ActiveSession>;
  /** Number of currently tracked sessions (cheap accessor). */
  activeCount(): number;
  /**
   * v0.4.3 — set live action description for a session. Called by broker
   * server.ts when it observes hook events (PreToolUse → tool name verb).
   * If session not in pool yet, pre-creates an entry. Triggers
   * onSessionUpdate so the floater immediately re-broadcasts.
   */
  markAction(sid: string, action: string | null): void;
  /**
   * v0.4.3 — explicitly evict the session whose card the user just dismissed
   * (POST /dismiss from floater). Pass null to evict the most-recently-touched
   * non-hidden session (the one currently shown in the card).
   */
  dismissCurrent(): void;
  /**
   * Test/diagnostic hook — resolves once every in-flight event handler
   * (including its inner fetch chain to `/session/<sid>` and
   * `/session/<sid>/message`) has settled. Production code does not need
   * this; tests use it to deflake assertions that depend on title /
   * lastMessage being populated.
   */
  whenIdle(): Promise<void>;
}

/**
 * Public factory. Lazy: constructing does NOT open the stream — call `start()`.
 */
export function createEventSource(opts: EventSourceOptions): EventSourceHandle {
  const baseUrl = opts.daemonUrl ?? DEFAULT_DAEMON_URL;
  const eventsUrl = `${baseUrl}/mavis/api/events`;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.logger;
  // v0.4.3 — default 0 disables auto-eviction. Done cards stick around
  // until the user explicitly dismisses (floater POST /dismiss on hover).
  // Tests / advanced configs can pass a positive ms to opt back into the
  // pre-v0.4.3 5-minute auto-evict behavior.
  const evictAfterMs = opts.evictAfterMs ?? 0;
  const initialBackoffMs = opts.initialBackoffMs ?? 500;
  const maxBackoffMs = opts.maxBackoffMs ?? 30_000;
  const maxMessageChars = opts.maxMessageChars ?? 80;
  const onSessionUpdate = opts.onSessionUpdate;

  const sessions = new Map<string, ActiveSession>();
  let started = false;
  let stopped = false;
  let abortCtrl: AbortController | null = null;
  let reconnectTimer: TimerHandle | null = null;
  let backoffMs = initialBackoffMs;
  /** Tracks every async event handler so tests can await idle. */
  const inflight = new Set<Promise<void>>();

  // -------------------------------------------------------------------------
  // Daemon HTTP fetch helpers — fetch session info / latest message.
  // -------------------------------------------------------------------------

  async function fetchSessionTitle(sid: string): Promise<{ title?: string; displayName?: string } | undefined> {
    try {
      const r = await fetchImpl(`${baseUrl}/mavis/api/session/${sid}`);
      if (!r.ok) return undefined;
      const j = (await r.json()) as { session?: { title?: unknown; displayName?: unknown; agentName?: unknown } };
      // v0.4.3 — daemon wraps result in `{session: {...}}` envelope.
      const sess = j?.session ?? (j as unknown as { title?: unknown; displayName?: unknown; agentName?: unknown });
      const out: { title?: string; displayName?: string } = {};
      if (sess && typeof sess === "object") {
        const t = (sess as { title?: unknown }).title;
        if (typeof t === "string" && t.trim()) out.title = t.trim();
        const d = (sess as { displayName?: unknown }).displayName;
        if (typeof d === "string" && d.trim()) {
          out.displayName = d.trim();
        } else {
          // Fallback to agentName (raw agent id) if no displayName.
          const a = (sess as { agentName?: unknown }).agentName;
          if (typeof a === "string" && a.trim()) out.displayName = a.trim();
        }
      }
      return Object.keys(out).length ? out : undefined;
    } catch (err) {
      log?.debug("event_source_fetch_session_failed", {
        sid,
        err: (err as Error).message,
      });
    }
    return undefined;
  }

  async function fetchLatestMessage(
    sid: string,
    minTimestamp?: number,
  ): Promise<string | undefined> {
    try {
      // v0.4.3 — pull a small batch (5) and pick the most-recent
      // ASSISTANT message that has actual text content. We can't ask for
      // limit=1 because the most-recent is often a tool_call (msg_type=2,
      // tool_calls only, no text) or a user message — both have nothing
      // to show. The daemon real schema is `{role, msg_type, msg_content,
      // tool_calls, timestamp, ...}`; assistant msg_type=1 is pure text,
      // msg_type=2 may be tool_call with optional msg_content commentary.
      //
      // v0.4.4 — `minTimestamp` (optional): when set, skip any message
      // whose timestamp <= minTimestamp. Used by `startMessagePolling` to
      // avoid pulling the previous turn's final reply during the race
      // window between session.start and the new turn's first chunk.
      const r = await fetchImpl(
        `${baseUrl}/mavis/api/session/${sid}/message?limit=5`,
      );
      if (!r.ok) return undefined;
      const j = (await r.json()) as { messages?: unknown[] };
      const msgs = Array.isArray(j?.messages) ? j.messages : [];
      // Daemon returns messages in reverse-chronological order (newest first
      // in some endpoints, oldest first in others). Sort by timestamp desc
      // defensively, then pick first assistant with msg_content.
      type Row = {
        role?: string;
        msg_content?: string;
        timestamp?: number;
      };
      const sorted = (msgs as Row[])
        .filter((m) => m && typeof m === "object")
        .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
      for (const m of sorted) {
        if (m.role !== "assistant") continue;
        if (typeof m.msg_content !== "string" || !m.msg_content.trim())
          continue;
        if (
          typeof minTimestamp === "number" &&
          (typeof m.timestamp !== "number" || m.timestamp <= minTimestamp)
        ) {
          continue;
        }
        return truncate(m.msg_content, maxMessageChars);
      }
    } catch (err) {
      log?.debug("event_source_fetch_message_failed", {
        sid,
        err: (err as Error).message,
      });
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Per-event handlers.
  // -------------------------------------------------------------------------

  async function handleEvent(name: string, data: unknown): Promise<void> {
    // v0.4.3 — filter high-frequency noise events that have no per-session
    // semantics (would inflate sessions Map + spam logs). Daemon emits
    // fs.change for every workspace file mutation, system.* / config.* etc.
    // Heartbeats are stripped by the SSE reader before reaching here.
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
      // Daemon emits these (verified via 60s SSE tap on real daemon, see
      // v0.4.3 schema investigation). The pre-v0.4.3 broker listened for
      // `run_status_changed` / `message_update` / `message_end` /
      // `session.new` — NONE of those exist on /api/events.
      case "session.created": {
        // v0.4.3 — flag cron-triggered sessions as hidden so they don't surface
        // on the floater card. Daemon payload has `purpose: "cron:<agent>:<name>"`
        // for cron-spawned sessions; user-prompted sessions either omit it or
        // use a non-cron purpose string.
        const payload =
          (data && typeof data === "object" && (data as { payload?: unknown }).payload) || {};
        const purpose =
          payload && typeof payload === "object"
            ? (payload as { purpose?: unknown }).purpose
            : undefined;
        if (typeof purpose === "string" && purpose.startsWith("cron:")) {
          sess.hidden = true;
        }
        // New session — fetch title (might still be undefined; another
        // session.title_updated will follow once the LLM names it). Also
        // fetches displayName for fallback when title is empty.
        if (!sess.title || !sess.displayName) {
          const info = await fetchSessionTitle(sid);
          if (info?.title && !sess.title) sess.title = info.title;
          if (info?.displayName && !sess.displayName) sess.displayName = info.displayName;
        }
        // Pull initial latest message (might be empty for fresh session).
        const fetched = await fetchLatestMessage(sid);
        if (fetched) sess.lastMessage = fetched;
        break;
      }
      case "session.start": {
        // Turn started — equivalent to old run_status_changed:started.
        sess.status = "started";
        // v0.4.3 — reset live status to "thinking" for the new turn.
        // PreToolUse will overwrite with a more specific verb if a tool fires.
        sess.currentAction = "正在思考";
        // v0.4.4 — bug fix: explicitly clear the previous turn's
        // lastMessage so the floater card stops showing stale "done"
        // text while the new turn is mid-flight. Combined with
        // `lastTurnStartTimestamp` below, the polling loop's first
        // fetch (which races against daemon producing the new turn's
        // first chunk) won't pull the prior reply back in.
        sess.lastMessage = undefined;
        sess.lastTurnStartTimestamp = opts.clock.now();
        cancelEvict(sess);
        if (!sess.title || !sess.displayName) {
          const info = await fetchSessionTitle(sid);
          if (info?.title && !sess.title) sess.title = info.title;
          if (info?.displayName && !sess.displayName) sess.displayName = info.displayName;
        }
        // v0.4.3 — start 1.5s polling for live lastMessage updates so the
        // floater card subtitle reflects the streaming reply chunk-by-chunk
        // (daemon doesn't push tokens via /api/events).
        startMessagePolling(sess);
        break;
      }
      case "session.finish": {
        // Turn ended — equivalent to old run_status_changed:finished.
        sess.status = "finished";
        // v0.4.3 — clear live action so subtitle falls back to real lastMessage.
        sess.currentAction = undefined;
        // Stop polling — final message will be fetched once below.
        stopMessagePolling(sess);
        // Final pull of latest message (the just-completed assistant reply).
        const fetched = await fetchLatestMessage(sid);
        if (fetched) sess.lastMessage = fetched;
        scheduleEvict(sess);
        break;
      }
      case "session.title_updated": {
        // Title changed (LLM auto-name or user rename) — pull from payload
        // so we don't need an extra HTTP round-trip.
        const t = extractTitleFromPayload(data);
        if (t) sess.title = t;
        break;
      }
      case "session.compressed":
      case "session.deleted":
      case "session.abort": {
        // Drop session immediately; no longer interesting to surface.
        sessions.delete(sid);
        break;
      }
      case "permission.ask": {
        // v0.4.4 — primary perm-pending signal source. Daemon emits this
        // when a tool call hits a permission gate, before the perm-poller's
        // 1.5s loop even gets a chance to see the new entry. We forward
        // immediately to the broker state machine via the
        // `onPermissionAsk` callback (server.ts wires this to
        // `machine.ingest({kind: "PermissionRequested", sessionId})`).
        //
        // The perm-poller (now polling every 5s instead of 1.5s) is
        // retained ONLY as a `PermissionResolved` detector — daemon
        // doesn't emit a corresponding `permission.resolved` event, so
        // we still need to diff the pending-list to learn when a perm
        // gets answered.
        const payload =
          (data && typeof data === "object" && (data as { payload?: unknown }).payload) || {};
        const requestId =
          payload && typeof payload === "object"
            ? (payload as { requestId?: unknown }).requestId
            : undefined;
        opts.onPermissionAsk?.(sid, typeof requestId === "string" ? requestId : undefined);
        break;
      }
      default: {
        // Unknown event but has a sessionId: keep tracking + log.
        log?.debug("event_source_unknown_event", { name });
      }
    }

    // v0.4.3 — notify broker that this session's data may have changed,
    // so it can re-broadcast a WS state message with the latest title /
    // lastMessage. Without this, SSE updates only surface to the floater
    // when a hook event happens to fire onChange.
    try {
      onSessionUpdate?.();
    } catch (err) {
      log?.warn("event_source_on_session_update_error", {
        err: (err as Error).message,
      });
    }
  }

  function ensureSession(sid: string, now: number): ActiveSession {
    let s = sessions.get(sid);
    if (!s) {
      s = { sessionId: sid, lastTouchedAt: now };
      sessions.set(sid, s);
    }
    return s;
  }

  function scheduleEvict(s: ActiveSession): void {
    cancelEvict(s);
    // v0.4.3 — opt-out: 0 means "don't auto-evict, wait for user dismiss".
    if (evictAfterMs <= 0) return;
    s.evictTimer = opts.clock.setTimeout(() => {
      sessions.delete(s.sessionId);
    }, evictAfterMs);
  }

  function cancelEvict(s: ActiveSession): void {
    if (s.evictTimer) {
      opts.clock.clearTimeout(s.evictTimer);
      s.evictTimer = null;
    }
  }

  /**
   * v0.4.3 — start a 1.5s polling loop that re-fetches the latest assistant
   * message for a `started` session. The mavis daemon does NOT push token
   * stream over /api/events (that's only on the per-session POST response),
   * so we have to pull. Polling stops automatically on session.finish or
   * eviction. Idempotent — calling with a session that already has a poller
   * is a no-op.
   */
  function startMessagePolling(s: ActiveSession): void {
    if (s.pollTimer) return;
    const tick = async () => {
      // If session moved on (finished / evicted), stop.
      if (s.status !== "started" || !sessions.has(s.sessionId)) {
        s.pollTimer = null;
        return;
      }
      try {
        // v0.4.4 — pass `lastTurnStartTimestamp` so a polling fetch that
        // races against daemon producing the new turn's first chunk
        // skips the previous turn's final reply (avoids stale "done"
        // text resurrecting on the card).
        const fetched = await fetchLatestMessage(
          s.sessionId,
          s.lastTurnStartTimestamp,
        );
        if (fetched && fetched !== s.lastMessage) {
          s.lastMessage = fetched;
          s.lastTouchedAt = opts.clock.now();
          try {
            onSessionUpdate?.();
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore poll error — next tick will retry */
      }
      // Recurse via setTimeout (Clock interface has no setInterval; this
      // also makes each poll wait for the previous fetch to finish).
      if (s.status === "started" && sessions.has(s.sessionId)) {
        s.pollTimer = opts.clock.setTimeout(() => void tick(), 1500);
      } else {
        s.pollTimer = null;
      }
    };
    // Kick off immediately too — don't wait 1.5s for the first one.
    s.pollTimer = opts.clock.setTimeout(() => void tick(), 0);
  }

  function stopMessagePolling(s: ActiveSession): void {
    if (s.pollTimer) {
      opts.clock.clearTimeout(s.pollTimer);
      s.pollTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // SSE stream loop — fetch + ReadableStream + line parser.
  // -------------------------------------------------------------------------

  async function runOnce(): Promise<void> {
    abortCtrl = new AbortController();
    let response: Response;
    try {
      response = await fetchImpl(eventsUrl, {
        signal: abortCtrl.signal,
        headers: { accept: "text/event-stream" },
      });
    } catch (err) {
      if (stopped) return;
      log?.debug("event_source_connect_failed", {
        err: (err as Error).message,
      });
      throw err;
    }
    if (!response.ok) {
      log?.warn("event_source_http_error", { status: response.status });
      throw new Error(`SSE HTTP ${response.status}`);
    }
    if (!response.body) {
      log?.warn("event_source_no_body");
      throw new Error("SSE response had no body");
    }

    log?.info("event_source_connected", { url: eventsUrl });
    backoffMs = initialBackoffMs; // reset on successful connect

    const reader = (
      response.body as ReadableStream<Uint8Array>
    ).getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    // Pending event accumulator — SSE event blocks are separated by blank lines.
    let curEventName = "message"; // default per SSE spec
    let curDataLines: string[] = [];

    const flush = async (): Promise<void> => {
      if (curDataLines.length === 0 && curEventName === "message") return;
      const raw = curDataLines.join("\n");
      let parsed: unknown = raw;
      if (raw) {
        try {
          parsed = JSON.parse(raw);
        } catch {
          // Leave parsed as raw string — handlers extract defensively.
        }
      }
      const eventName = curEventName;
      // Track the handler in `inflight` so tests can await whenIdle().
      // We do NOT await inside the stream loop — the loop is allowed to
      // continue parsing the next event while the previous handler's
      // fetch chain settles. This matches typical SSE consumer semantics.
      const p = (async () => {
        try {
          await handleEvent(eventName, parsed);
        } catch (err) {
          log?.warn("event_source_handler_error", {
            event: eventName,
            err: (err as Error).message,
          });
        }
      })();
      inflight.add(p);
      void p.finally(() => {
        inflight.delete(p);
      });
      curEventName = "message";
      curDataLines = [];
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Split on \n; keep last partial line in buffer.
      let nlIdx: number;
      while ((nlIdx = buffer.indexOf("\n")) !== -1) {
        let line = buffer.slice(0, nlIdx);
        buffer = buffer.slice(nlIdx + 1);
        // Strip trailing \r (CRLF tolerance).
        if (line.endsWith("\r")) line = line.slice(0, -1);

        if (line === "") {
          // Blank line → dispatch event block.
          await flush();
          continue;
        }
        // Comment line per SSE spec.
        if (line.startsWith(":")) continue;

        const colonIdx = line.indexOf(":");
        let field: string;
        let val: string;
        if (colonIdx === -1) {
          field = line;
          val = "";
        } else {
          field = line.slice(0, colonIdx);
          val = line.slice(colonIdx + 1);
          // SSE spec: optional single space after colon.
          if (val.startsWith(" ")) val = val.slice(1);
        }
        if (field === "event") {
          curEventName = val || "message";
        } else if (field === "data") {
          curDataLines.push(val);
        } else if (field === "id" || field === "retry") {
          // Ignored — we manage reconnect on our own.
        } else {
          // Unknown SSE field — ignore per spec.
        }
      }
    }

    // Stream ended — flush any pending block then return so caller schedules reconnect.
    await flush();
  }

  function scheduleReconnect(): void {
    if (stopped) return;
    log?.debug("event_source_reconnect_scheduled", { ms: backoffMs });
    reconnectTimer = opts.clock.setTimeout(() => {
      reconnectTimer = null;
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
      void loop();
    }, backoffMs);
  }

  async function loop(): Promise<void> {
    if (stopped) return;
    try {
      await runOnce();
    } catch (err) {
      if (stopped) return;
      log?.debug("event_source_stream_error", {
        err: (err as Error).message,
      });
    } finally {
      abortCtrl = null;
    }
    scheduleReconnect();
  }

  return {
    start() {
      if (started) return;
      started = true;
      stopped = false;
      log?.info("event_source_starting", { url: eventsUrl });
      void loop();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (reconnectTimer) {
        opts.clock.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (abortCtrl) {
        try {
          abortCtrl.abort();
        } catch {
          /* ignore */
        }
        abortCtrl = null;
      }
      // Cancel all pending evict timers.
      for (const s of sessions.values()) cancelEvict(s);
      log?.info("event_source_stopped");
    },
    getActiveSessions() {
      return new Map(sessions);
    },
    activeCount() {
      return sessions.size;
    },
    markAction(sid, action) {
      // v0.4.3 — broker calls this on PreToolUse hook events to update the
      // live status (e.g. "执行命令" for bash, "搜索代码" for grep). May be
      // called for sessions not yet in pool (e.g. before session.start
      // arrives) — in that case create a stub entry so we don't lose the
      // action when SSE catches up.
      const now = opts.clock.now();
      let s = sessions.get(sid);
      if (!s) {
        s = ensureSession(sid, now);
      }
      if (action === null || action === "") {
        s.currentAction = undefined;
      } else {
        s.currentAction = action;
      }
      s.lastTouchedAt = now;
      try {
        onSessionUpdate?.();
      } catch {
        /* ignore */
      }
    },
    dismissCurrent() {
      // Pick the most-recently-touched non-hidden session and evict it.
      // Used by floater hover-on-done card to clear the displayed entry.
      let best: ActiveSession | null = null;
      for (const s of sessions.values()) {
        if (s.hidden) continue;
        if (!best || s.lastTouchedAt > best.lastTouchedAt) best = s;
      }
      if (best) {
        cancelEvict(best);
        stopMessagePolling(best);
        sessions.delete(best.sessionId);
        try {
          onSessionUpdate?.();
        } catch {
          /* ignore */
        }
      }
    },
    async whenIdle() {
      // Drain in waves — each handler may schedule another inner await chain
      // (fetch + json), so we re-snapshot until the set stays empty across
      // a microtask tick.
      while (inflight.size > 0) {
        await Promise.allSettled(Array.from(inflight));
      }
    },
  };
}

// -----------------------------------------------------------------------------
// Defensive field-extraction helpers.
// -----------------------------------------------------------------------------

function extractField(data: unknown, key: string): unknown {
  if (!data || typeof data !== "object") return undefined;
  return (data as Record<string, unknown>)[key];
}

/**
 * Extract sessionId from a daemon SSE event.
 *
 * Daemon uses a standardized envelope `{type, timestamp, source, payload}`
 * (see `EventBus.emit` in daemon.js). All session-related fields live under
 * `data.payload.*`. We try `data.payload.sessionId` FIRST (the real shape),
 * then fall back to flat `data.sessionId` etc. for forward-compat with any
 * future event types that might inline fields.
 */
function extractSessionId(data: unknown): string | undefined {
  // Daemon real shape: data.payload.sessionId
  if (data && typeof data === "object") {
    const payload = (data as { payload?: unknown }).payload;
    if (payload && typeof payload === "object") {
      for (const k of ["sessionId", "session_id", "sid"]) {
        const v = (payload as Record<string, unknown>)[k];
        if (typeof v === "string" && v) return v;
      }
    }
  }
  // Fallback: flat (defensive — never observed but keep for forward-compat).
  for (const k of ["sessionId", "session_id", "sid"]) {
    const v = extractField(data, k);
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

/**
 * Extract a string title from a daemon SSE event payload.
 * Used by `session.title_updated` to set sess.title without an extra HTTP fetch.
 */
function extractTitleFromPayload(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const payload = (data as { payload?: unknown }).payload;
  if (payload && typeof payload === "object") {
    const t = (payload as { title?: unknown }).title;
    if (typeof t === "string" && t.trim()) return t.trim();
  }
  return undefined;
}

function truncate(s: string, max: number): string {
  // Single-line — strip newlines so the floater card stays one line.
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max - 1) + "…";
}
