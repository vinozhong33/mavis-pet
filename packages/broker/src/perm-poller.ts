/**
 * Pet Broker — mavis daemon permission poller (v0.4.4 simplified).
 *
 * Daemon emits `permission.ask` on EventBus when a perm gate hits, but does
 * NOT emit a corresponding `permission.resolved`/`granted`/`denied` event.
 *
 * As of v0.4.4 the poller's responsibilities split cleanly:
 *
 *   - REQUESTED signal → handled by SSE `permission.ask` subscriber in
 *     `event-source.ts` (~100ms latency, was 1.5s).
 *   - RESOLVED signal → handled here, by polling `GET /mavis/api/permission/requests`
 *     every `intervalMs` (default 5000ms) and diffing against the previous
 *     poll. Vanished requestIds → `PermissionResolved`.
 *
 * Why we still need polling: the alternative — assuming a `PreToolUse` hook
 * arrival means perm got allow'd — fails for the deny path (no subsequent
 * tool call ever fires; session may sit idle indefinitely).
 *
 * Zombie-entry protection: after `stalePollThreshold` consecutive polls
 * (default 3 ≈ 15s with 5s interval) the poller treats the request as
 * approved-but-not-cleared (a known daemon quirk where the perm endpoint
 * sometimes leaves answered entries in the pending list) and forces a
 * `PermissionResolved` so the floater doesn't get stuck in clock state.
 */

import type { Clock, TimerHandle } from "./clock.js";
import type { Logger } from "./logger.js";
import type { StateMachine } from "./state-machine.js";

/** Shape of one entry in `GET /mavis/api/permission/requests`. */
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
  /** Poll interval in ms. Default 5000 (was 1500 pre-v0.4.4). */
  intervalMs?: number;
  /** Per-request timeout in ms. Default 1500. */
  fetchTimeoutMs?: number;
  /**
   * v0.4.4 — # of consecutive polls a requestId can persist before being
   * treated as zombie (force PermissionResolved). Default 3 ≈ 15s with
   * 5s intervalMs. Lower = quicker UX recovery; higher = more tolerant
   * of slow user response.
   */
  stalePollThreshold?: number;
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
  const url = `${opts.daemonUrl ?? DEFAULT_DAEMON_URL}/mavis/api/permission/requests`;
  const intervalMs = opts.intervalMs ?? 5000;
  const fetchTimeoutMs = opts.fetchTimeoutMs ?? 1500;
  const stalePollThreshold = opts.stalePollThreshold ?? 3;
  const log = opts.logger;

  /** requestId → sessionId of the LAST poll. */
  let seen = new Map<string, string>();
  /** Per-requestId staleness counter (zombie detection). */
  const stalePollCount = new Map<string, number>();
  /**
   * v0.4.4.1 — `requestId`s already force-resolved as zombies. Daemon may
   * keep returning them in the pending list indefinitely (the original
   * "daemon never clears approved perms" bug); without this set, every
   * `stalePollThreshold` polls (~15s) we'd re-fire `PermissionResolved`
   * forever, spamming logs and bouncing the broker state machine.
   *
   * Cleanup: when a reqId vanishes from cur (daemon finally cleared it),
   * we drop it from this set so memory doesn't grow unbounded.
   */
  const processedZombies = new Set<string>();
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

    // v0.4.4.1 — gc processedZombies for entries the daemon finally cleared.
    for (const reqId of processedZombies) {
      if (!cur.has(reqId)) processedZombies.delete(reqId);
    }

    // Zombie detection: bump per-requestId staleness counter for entries
    // still in cur (and NOT already-processed zombies). Drop counters for
    // entries that vanished.
    const zombies = new Set<string>();
    for (const reqId of cur.keys()) {
      if (processedZombies.has(reqId)) continue; // already force-resolved
      const next = (stalePollCount.get(reqId) ?? 0) + 1;
      stalePollCount.set(reqId, next);
      if (next > stalePollThreshold) zombies.add(reqId);
    }
    for (const reqId of stalePollCount.keys()) {
      if (!cur.has(reqId)) stalePollCount.delete(reqId);
    }

    // v0.4.4 — REMOVED: "new requestId → emit PermissionRequested" branch.
    // The SSE `permission.ask` subscriber in event-source.ts now owns this
    // signal. Polling here would be a redundant second emit.

    // Vanished requestIds → PermissionResolved.
    for (const [reqId, sid] of seen) {
      if (!cur.has(reqId)) {
        opts.machine.ingest({ kind: "PermissionResolved", sessionId: sid });
      }
    }

    // Zombie requestIds: still in cur but stale → force PermissionResolved
    // ONCE, then mark as processed so subsequent polls skip them. Without
    // the processedZombies set, we'd re-fire every ~15s for any perm the
    // daemon refuses to clear, spamming logs and confusing UI.
    for (const reqId of zombies) {
      const sid = cur.get(reqId);
      if (sid) {
        opts.machine.ingest({ kind: "PermissionResolved", sessionId: sid });
        log?.warn("perm_poll_zombie_resolved", {
          requestId: reqId,
          sessionId: sid,
          stalePolls: stalePollCount.get(reqId),
        });
        processedZombies.add(reqId);
        stalePollCount.delete(reqId);
      }
    }

    // Build new `seen` from cur — but exclude processed zombies so the
    // vanish-detect branch above doesn't re-emit Resolved for them when
    // the daemon eventually clears them. (They're already considered
    // resolved from the floater's perspective.)
    const nextSeen = new Map<string, string>();
    for (const [reqId, sid] of cur) {
      if (!processedZombies.has(reqId)) nextSeen.set(reqId, sid);
    }
    seen = nextSeen;
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

  // v0.4.4 — first poll runs once to seed `seen` so we don't fire spurious
  // PermissionResolved on startup for requests that were already pending
  // before broker started. SSE permission.ask subscriber handles new asks
  // from the moment broker connects.
  void pollOnce().then(() => schedule());

  log?.info("perm_poller_started", {
    url,
    intervalMs,
    stalePollThreshold,
    role: "resolved-detector-only (v0.4.4+)",
  });

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
