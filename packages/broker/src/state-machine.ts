/**
 * Pet Broker — state machine.
 *
 * Per-session view:
 *   - PreToolUse                  → session enters RUNNING
 *   - PostToolUse(exitCode == 0)  → keep RUNNING (work continues)
 *   - PostToolUse(exitCode != 0)  → session enters FAILED, auto-degrades
 *                                   after `failedDegradeMs` (default 2000)
 *   - MessageComplete             → transient WAVE for `waveDurationMs`
 *                                   (default 1000), then degrade
 *   - 30 s of silence (`idleAfterMs`) on a session → session enters IDLE
 *
 * Global aggregation across ALL sessions, highest priority wins:
 *   FAILED > RUNNING > WAVE > IDLE
 *
 * Time discipline: every timer goes through the injected {@link Clock} so
 * the entire machine is deterministic in tests.
 *
 * Listener model: a single onChange callback is fired ONLY when the
 * aggregated global state actually changes. Idempotent transitions
 * (RUNNING → RUNNING) do not re-fire — this matters because clients
 * subscribe over WebSocket and we don't want flicker.
 */

import type { Clock, TimerHandle } from "./clock.js";
import type {
  HookEvent,
  HookEventKind,
  PetState,
  SessionStatus,
} from "./types.js";

export interface StateMachineOptions {
  clock: Clock;
  /** ms after which a FAILED session degrades back. Default 2000. */
  failedDegradeMs?: number;
  /** ms after which a WAVE session degrades back. Default 1000. */
  waveDurationMs?: number;
  /** ms of silence before a session is considered IDLE. Default 30000. */
  idleAfterMs?: number;
}

/** Priority used for global aggregation. Higher number wins. */
const STATE_PRIORITY: Record<PetState, number> = {
  failed: 4,
  run: 3,
  wave: 2,
  idle: 1,
};

interface SessionRecord {
  sessionId: string;
  /** "Underlying" state after the most recent definitive event. Either RUNNING or IDLE. */
  baseState: "run" | "idle";
  /** Transient overlay (FAILED or WAVE) that overrides baseState when active. */
  overlay: "failed" | "wave" | null;
  /** Timer for overlay degrade. */
  overlayTimer: TimerHandle | null;
  /** Timer for silent → IDLE degrade. */
  idleTimer: TimerHandle | null;
  lastEventTs: number;
  lastEventKind?: HookEventKind;
}

export type StateChangeListener = (state: PetState, ts: number) => void;

export class StateMachine {
  private readonly clock: Clock;
  private readonly failedDegradeMs: number;
  private readonly waveDurationMs: number;
  private readonly idleAfterMs: number;
  private readonly sessions = new Map<string, SessionRecord>();
  private listeners: StateChangeListener[] = [];
  private currentGlobal: PetState = "idle";
  private lastChangeTs: number;

  constructor(opts: StateMachineOptions) {
    this.clock = opts.clock;
    this.failedDegradeMs = opts.failedDegradeMs ?? 2_000;
    this.waveDurationMs = opts.waveDurationMs ?? 1_000;
    this.idleAfterMs = opts.idleAfterMs ?? 30_000;
    this.lastChangeTs = this.clock.now();
  }

  /** Subscribe to global state changes. */
  onChange(listener: StateChangeListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /** Current aggregated global state. */
  get globalState(): PetState {
    return this.currentGlobal;
  }

  /** ts (ms) of the most recent global state change. */
  get lastChangeAt(): number {
    return this.lastChangeTs;
  }

  /** Snapshot of every session for `GET /status`. */
  snapshotSessions(): SessionStatus[] {
    return Array.from(this.sessions.values()).map((s) => ({
      sessionId: s.sessionId,
      state: this.effectiveState(s),
      lastEventTs: s.lastEventTs,
      lastEventKind: s.lastEventKind,
    }));
  }

  /** Process an inbound hook event. */
  ingest(event: HookEvent): void {
    const now = event.ts ?? this.clock.now();
    const session = this.getOrCreate(event.sessionId);
    session.lastEventTs = now;
    session.lastEventKind = event.kind;

    switch (event.kind) {
      case "PreToolUse":
        this.applyPreToolUse(session);
        break;
      case "PostToolUse":
        this.applyPostToolUse(session, event.exitCode);
        break;
      case "MessageComplete":
        this.applyMessageComplete(session);
        break;
    }

    // Each event resets the silence-to-idle timer for that session.
    this.armIdleTimer(session);

    this.recompute(now);
  }

  /**
   * Drop a session entirely (e.g. caller knows it ended).
   * Not currently invoked by HTTP handlers but exposed for tests / future use.
   */
  forgetSession(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (s.overlayTimer) this.clock.clearTimeout(s.overlayTimer);
    if (s.idleTimer) this.clock.clearTimeout(s.idleTimer);
    this.sessions.delete(sessionId);
    this.recompute(this.clock.now());
  }

  /** Disposes all timers. Useful when the broker shuts down. */
  dispose(): void {
    for (const s of this.sessions.values()) {
      if (s.overlayTimer) this.clock.clearTimeout(s.overlayTimer);
      if (s.idleTimer) this.clock.clearTimeout(s.idleTimer);
    }
    this.sessions.clear();
    this.listeners = [];
  }

  // ---------------------------------------------------------------------------
  // Internal: per-event transitions
  // ---------------------------------------------------------------------------

  private applyPreToolUse(s: SessionRecord): void {
    s.baseState = "run";
    // Pre-tool kills any lingering WAVE; FAILED is intentionally preserved
    // because PreToolUse can fire WHILE a previous tool is still failing.
    // Spec says "FAILED 2 秒后回 RUNNING" — the timer handles that, we don't
    // forcibly clear here.
    if (s.overlay === "wave") {
      this.clearOverlay(s);
    }
  }

  private applyPostToolUse(s: SessionRecord, exitCode: number | undefined): void {
    if (typeof exitCode === "number" && exitCode !== 0) {
      // Failure → set FAILED overlay with degrade timer.
      s.baseState = "run"; // session is still alive, just had a hiccup
      this.setOverlay(s, "failed", this.failedDegradeMs);
    } else {
      // Success → keep baseState=RUNNING. PostToolUse alone does not move
      // to IDLE; that only happens via silence timeout.
      s.baseState = "run";
      if (s.overlay === "wave") {
        // Successful tool replaces any pending WAVE.
        this.clearOverlay(s);
      }
    }
  }

  private applyMessageComplete(s: SessionRecord): void {
    // MessageComplete signals end of an agent turn. We keep baseState as IDLE
    // because the agent is now waiting on the user; the silence timer would
    // have eventually moved us there anyway. The transient WAVE overlay is
    // the visible signal.
    s.baseState = "idle";
    this.setOverlay(s, "wave", this.waveDurationMs);
  }

  // ---------------------------------------------------------------------------
  // Internal: timer plumbing
  // ---------------------------------------------------------------------------

  private setOverlay(
    s: SessionRecord,
    overlay: "failed" | "wave",
    durationMs: number,
  ): void {
    if (s.overlayTimer) this.clock.clearTimeout(s.overlayTimer);
    s.overlay = overlay;
    s.overlayTimer = this.clock.setTimeout(() => {
      s.overlay = null;
      s.overlayTimer = null;
      this.recompute(this.clock.now());
    }, durationMs);
  }

  private clearOverlay(s: SessionRecord): void {
    if (s.overlayTimer) this.clock.clearTimeout(s.overlayTimer);
    s.overlay = null;
    s.overlayTimer = null;
  }

  private armIdleTimer(s: SessionRecord): void {
    if (s.idleTimer) this.clock.clearTimeout(s.idleTimer);
    s.idleTimer = this.clock.setTimeout(() => {
      s.baseState = "idle";
      s.idleTimer = null;
      this.recompute(this.clock.now());
    }, this.idleAfterMs);
  }

  private getOrCreate(sessionId: string): SessionRecord {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = {
        sessionId,
        baseState: "idle",
        overlay: null,
        overlayTimer: null,
        idleTimer: null,
        lastEventTs: this.clock.now(),
      };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  // ---------------------------------------------------------------------------
  // Internal: aggregation
  // ---------------------------------------------------------------------------

  /** What this session contributes to the global aggregation. */
  private effectiveState(s: SessionRecord): PetState {
    if (s.overlay) return s.overlay;
    return s.baseState;
  }

  /**
   * Recompute global state and notify listeners if it changed.
   * Always called with the current ts (the `now` used to drive the
   * triggering event/timer) so emitted ts is consistent.
   */
  private recompute(now: number): void {
    let winner: PetState = "idle";
    let winnerScore = STATE_PRIORITY.idle;
    for (const s of this.sessions.values()) {
      const e = this.effectiveState(s);
      const score = STATE_PRIORITY[e];
      if (score > winnerScore) {
        winner = e;
        winnerScore = score;
      }
    }

    if (winner !== this.currentGlobal) {
      this.currentGlobal = winner;
      this.lastChangeTs = now;
      for (const l of this.listeners) {
        try {
          l(winner, now);
        } catch {
          // Listener errors must not break the machine.
        }
      }
    }
  }
}
