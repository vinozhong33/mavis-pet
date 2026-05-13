/**
 * Pet Broker — mavis daemon permission poller.
 *
 * mavis daemon currently does NOT emit hook events for permission requests
 * (PreToolUse/PostToolUse fire AFTER perm is resolved, so they're useless
 * for the "agent is waiting on user decision" signal). But the daemon DOES
 * expose `GET /api/permission/requests` which returns all currently pending
 * permission requests.
 *
 * This module polls that endpoint every `intervalMs` (default 1500ms), diffs
 * against the previous poll to detect:
 *   - new requestId → emit PermissionRequested for that session
 *   - missing requestId → emit PermissionResolved for that session
 *
 * Resulting events are pushed through the same StateMachine.ingest path as
 * normal hook events, so the rest of the broker pipeline (state machine,
 * WS broadcast, default bubbles) needs no special-casing.
 *
 * Polling is the recommended path because:
 *   - zero daemon-side changes required
 *   - covers ALL perm sources (CLI prompts, IM bridge, cron, etc.) automatically
 *   - the resolved signal is "free" via set difference, no second emit point needed
 *   - tradeoff is 1.5s latency, which is fine for an ambient-signal floater
 */

import type { Clock, TimerHandle } from "./clock.js";
import type { Logger } from "./logger.js";
import type { StateMachine } from "./state-machine.js";

/** Shape of one entry in `GET /api/permission/requests`. */
interface PermissionRequest {
  requestId: string;
  sessionId: string;
  agentName?: string;
  toolName?: string;
  // Other fields ignored — we only need requestId + sessionId.
}

interface PermissionResponse {
  requests?: PermissionRequest[];
}

export interface PermPollerOptions {
  clock: Clock;
  /** State machine to feed events into. */
  machine: StateMachine;
  /** Daemon URL, e.g. http://127.0.0.1:15321. Default reads MAVIS_DAEMON_URL or http://127.0.0.1:15321 */
  daemonUrl?: string;
  /** Poll interval in ms. Default 1500. */
  intervalMs?: number;
  /** Per-request timeout in ms. Default 1000. */
  fetchTimeoutMs?: number;
  logger?: Logger;
}

export interface PermPoller {
  /** Stop polling. Idempotent. */
  stop(): void;
  /** Run one poll immediately (for tests / manual triggers). */
  pollOnce(): Promise<void>;
}

const DEFAULT_DAEMON_URL =
  process.env.MAVIS_DAEMON_URL ?? "http://127.0.0.1:15321";

export function startPermPoller(opts: PermPollerOptions): PermPoller {
  // v0.4.2 — fix endpoint prefix. The daemon mounts all business routes under
  // `/mavis/api/...`, not `/api/...`. v0.3 used the wrong prefix and got a
  // permanent 404, which is why we disabled the poller by default. Now that
  // the path is correct, re-enable by default in server.ts.
  const url = `${opts.daemonUrl ?? DEFAULT_DAEMON_URL}/mavis/api/permission/requests`;
  const intervalMs = opts.intervalMs ?? 1500;
  const fetchTimeoutMs = opts.fetchTimeoutMs ?? 1000;
  const log = opts.logger;

  /** requestId → sessionId of the LAST poll. */
  let seen = new Map<string, string>();
  let timer: TimerHandle | null = null;
  let stopped = false;
  /** Backoff after consecutive failures so we don't spam logs. */
  let consecutiveErrors = 0;

  async function pollOnce(): Promise<void> {
    if (stopped) return;
    let response: PermissionResponse | null = null;
    try {
      const ac = new AbortController();
      const t = opts.clock.setTimeout(() => ac.abort(), fetchTimeoutMs);
      try {
        const r = await fetch(url, { signal: ac.signal });
        if (!r.ok) {
          if (consecutiveErrors === 0) {
            log?.warn("perm_poll_http_error", { status: r.status });
          }
          consecutiveErrors++;
          return;
        }
        response = (await r.json()) as PermissionResponse;
      } finally {
        opts.clock.clearTimeout(t);
      }
    } catch (err) {
      if (consecutiveErrors === 0) {
        log?.warn("perm_poll_fetch_failed", {
          message: (err as Error).message,
        });
      }
      consecutiveErrors++;
      return;
    }
    consecutiveErrors = 0;

    const cur = new Map<string, string>();
    for (const r of response?.requests ?? []) {
      if (typeof r?.requestId === "string" && typeof r?.sessionId === "string") {
        cur.set(r.requestId, r.sessionId);
      }
    }

    // New requests → PermissionRequested for those sessions
    for (const [reqId, sid] of cur) {
      if (!seen.has(reqId)) {
        opts.machine.ingest({ kind: "PermissionRequested", sessionId: sid });
      }
    }
    // Vanished requests → PermissionResolved
    for (const [reqId, sid] of seen) {
      if (!cur.has(reqId)) {
        opts.machine.ingest({ kind: "PermissionResolved", sessionId: sid });
      }
    }

    seen = cur;
  }

  function schedule(): void {
    if (stopped) return;
    timer = opts.clock.setTimeout(async () => {
      try {
        await pollOnce();
      } catch (err) {
        log?.warn("perm_poll_unexpected", { message: (err as Error).message });
      }
      schedule();
    }, intervalMs);
  }

  // Kick off the first poll immediately so a user already has a pending perm
  // when broker starts will be picked up without waiting `intervalMs`.
  void pollOnce().then(() => schedule());

  log?.info("perm_poller_started", { url, intervalMs });

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer) {
        opts.clock.clearTimeout(timer);
        timer = null;
      }
      log?.info("perm_poller_stopped");
    },
    pollOnce,
  };
}
