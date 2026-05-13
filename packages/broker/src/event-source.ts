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
  /** Cached from `/mavis/api/session/<sid>/message?limit=1` (≤ 80 chars). */
  lastMessage?: string;
  /** Last known SSE status: 'started' | 'finished' | other (raw). */
  status?: string;
  /** ms ts of the last event that touched this session. */
  lastTouchedAt: number;
  /** When non-null, an evict timer scheduled for this session. */
  evictTimer?: TimerHandle | null;
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
  const evictAfterMs = opts.evictAfterMs ?? 5 * 60 * 1000;
  const initialBackoffMs = opts.initialBackoffMs ?? 500;
  const maxBackoffMs = opts.maxBackoffMs ?? 30_000;
  const maxMessageChars = opts.maxMessageChars ?? 80;

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

  async function fetchSessionTitle(sid: string): Promise<string | undefined> {
    try {
      const r = await fetchImpl(`${baseUrl}/mavis/api/session/${sid}`);
      if (!r.ok) return undefined;
      const j = (await r.json()) as { title?: unknown };
      if (typeof j?.title === "string" && j.title.trim()) return j.title.trim();
    } catch (err) {
      log?.debug("event_source_fetch_session_failed", {
        sid,
        err: (err as Error).message,
      });
    }
    return undefined;
  }

  async function fetchLatestMessage(sid: string): Promise<string | undefined> {
    try {
      const r = await fetchImpl(
        `${baseUrl}/mavis/api/session/${sid}/message?limit=1`,
      );
      if (!r.ok) return undefined;
      const j = (await r.json()) as
        | { messages?: unknown }
        | { message?: unknown }
        | unknown[];
      // Accept several shapes defensively.
      let msg: unknown;
      if (Array.isArray(j)) {
        msg = j[0];
      } else if (j && typeof j === "object") {
        const o = j as { messages?: unknown[]; message?: unknown };
        msg = (Array.isArray(o.messages) && o.messages[0]) || o.message;
      }
      const content = extractMessageContent(msg);
      if (!content) return undefined;
      return truncate(content, maxMessageChars);
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
    const sid = extractSessionId(data);
    if (!sid) {
      log?.debug("event_source_event_no_sid", { name });
      return;
    }
    const now = opts.clock.now();
    const sess = ensureSession(sid, now);

    switch (name) {
      case "run_status_changed": {
        const status = extractField(data, "status");
        sess.status = typeof status === "string" ? status : sess.status;
        sess.lastTouchedAt = now;
        if (sess.status === "started") {
          // Cancel any pending evict (re-started after finishing).
          cancelEvict(sess);
          // Lazily fetch title once; further started events keep cached value.
          if (!sess.title) {
            const title = await fetchSessionTitle(sid);
            if (title) sess.title = title;
          }
        } else if (sess.status === "finished") {
          // Schedule evict — keep around so the "done" card lingers briefly.
          scheduleEvict(sess);
        }
        break;
      }
      case "message_update":
      case "message_end": {
        sess.lastTouchedAt = now;
        // Try inline content first; fall back to fetching latest message.
        const inline = extractMessageContent(data);
        if (inline) {
          sess.lastMessage = truncate(inline, maxMessageChars);
        } else {
          const fetched = await fetchLatestMessage(sid);
          if (fetched) sess.lastMessage = fetched;
        }
        break;
      }
      case "session.new": {
        sess.lastTouchedAt = now;
        // session.new does not always carry a title; fetch it.
        if (!sess.title) {
          const title = await fetchSessionTitle(sid);
          if (title) sess.title = title;
        }
        break;
      }
      default: {
        // Unknown event: log + leave the session record in place (lastTouchedAt
        // updates so it doesn't look idle).
        sess.lastTouchedAt = now;
        log?.debug("event_source_unknown_event", { name });
      }
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

function extractSessionId(data: unknown): string | undefined {
  // Accept several common spellings: sessionId, session_id, sid.
  const candidates = ["sessionId", "session_id", "sid"];
  for (const k of candidates) {
    const v = extractField(data, k);
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

function extractMessageContent(data: unknown): string | undefined {
  if (!data) return undefined;
  if (typeof data === "string") return data;
  if (typeof data !== "object") return undefined;
  const o = data as Record<string, unknown>;
  // Try several common shapes.
  if (typeof o.content === "string") return o.content;
  if (typeof o.text === "string") return o.text;
  if (typeof o.preview === "string") return o.preview;
  // Anthropic-shaped: content is an array of {type:"text", text:"..."} blocks.
  if (Array.isArray(o.content)) {
    const parts: string[] = [];
    for (const blk of o.content) {
      if (
        blk &&
        typeof blk === "object" &&
        typeof (blk as { text?: unknown }).text === "string"
      ) {
        parts.push((blk as { text: string }).text);
      }
    }
    if (parts.length) return parts.join("");
  }
  return undefined;
}

function truncate(s: string, max: number): string {
  // Single-line — strip newlines so the floater card stays one line.
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max - 1) + "…";
}
