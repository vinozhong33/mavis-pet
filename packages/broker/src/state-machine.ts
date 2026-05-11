/**
 * Pet Broker — state machine.
 *
 * Per-session view (events drive state):
 *   - PreToolUse                  → session enters RUNNING (base)
 *   - PostToolUse(exitCode == 0)  → keep RUNNING
 *   - PostToolUse(exitCode != 0)  → FAILED overlay, auto-degrade after
 *                                   `failedDegradeMs` (default 2000)
 *   - MessageComplete             → WAVE overlay for `waveDurationMs`
 *                                   (default 1000), then degrade
 *   - UserPromptSubmit            → JUMP overlay for `jumpDurationMs`
 *                                   (default 1500), then degrade
 *   - SessionStart                → EXTRA1 overlay for `bootDurationMs`
 *                                   (default 2500), then degrade
 *   - SessionEnd                  → EXTRA2 overlay for `bootDurationMs`,
 *                                   then forget the session
 *   - 30 s of silence on a session → session enters IDLE (base)
 *
 * Global aggregation across ALL sessions, highest priority wins:
 *   FAILED > REVIEW > JUMP > EXTRA1 > EXTRA2 > WAVE > RUN > IDLE
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
  /** ms after which a JUMP session degrades back. Default 1500. */
  jumpDurationMs?: number;
  /** ms after which a SessionStart/End "extra" overlay degrades. Default 2500. */
  bootDurationMs?: number;
  /** ms of silence before a session is considered IDLE. Default 30000. */
  idleAfterMs?: number;
}

/** Priority used for global aggregation. Higher number wins. */
const STATE_PRIORITY: Record<PetState, number> = {
  failed: 8,
  review: 7,
  jump: 6,
  extra1: 5,
  extra2: 4,
  wave: 3,
  run: 2,
  idle: 1,
};

/** All states that can sit in the per-session overlay slot. */
type OverlayState = "failed" | "wave" | "jump" | "extra1" | "extra2" | "review";

interface SessionRecord {
  sessionId: string;
  /** "Underlying" state after the most recent definitive event. Either RUNNING or IDLE. */
  baseState: "run" | "idle";
  /** Transient overlay that overrides baseState when active. */
  overlay: OverlayState | null;
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
  private readonly jumpDurationMs: number;
  private readonly bootDurationMs: number;
  private readonly idleAfterMs: number;
  private readonly sessions = new Map<string, SessionRecord>();
  private listeners: StateChangeListener[] = [];
  private currentGlobal: PetState = "idle";
  private lastChangeTs: number;

  constructor(opts: StateMachineOptions) {
    this.clock = opts.clock;
    this.failedDegradeMs = opts.failedDegradeMs ?? 2_000;
    this.waveDurationMs = opts.waveDurationMs ?? 1_000;
    this.jumpDurationMs = opts.jumpDurationMs ?? 1_500;
    this.bootDurationMs = opts.bootDurationMs ?? 2_500;
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
      case "UserPromptSubmit":
        this.applyUserPromptSubmit(session);
        break;
      case "SessionStart":
        this.applySessionStart(session);
        break;
      case "SessionEnd":
        this.applySessionEnd(session, now);
        // SessionEnd schedules its own forget; recompute and return.
        this.recompute(now);
        return;
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
    if (s.overlay === "wave" || s.overlay === "jump") {
      this.clearOverlay(s);
    }
  }

  private applyPostToolUse(s: SessionRecord, exitCode: number | undefined): void {
    if (typeof exitCode === "number" && exitCode !== 0) {
      s.baseState = "run";
      this.setOverlay(s, "failed", this.failedDegradeMs);
    } else {
      s.baseState = "run";
      if (s.overlay === "wave" || s.overlay === "jump") {
        this.clearOverlay(s);
      }
    }
  }

  private applyMessageComplete(s: SessionRecord): void {
    // Agent finished a turn; we're now waiting on user input.
    s.baseState = "idle";
    this.setOverlay(s, "wave", this.waveDurationMs);
  }

  private applyUserPromptSubmit(s: SessionRecord): void {
    // User just sent a new message → short JUMP of joy.
    // Base resets to idle (agent hasn't tooled yet); next PreToolUse will
    // flip back to RUNNING and the JUMP timer will already have degraded.
    s.baseState = "idle";
    this.setOverlay(s, "jump", this.jumpDurationMs);
  }

  private applySessionStart(s: SessionRecord): void {
    // Session boot — short EXTRA1 overlay.
    s.baseState = "idle";
    this.setOverlay(s, "extra1", this.bootDurationMs);
  }

  private applySessionEnd(s: SessionRecord, now: number): void {
    // EXTRA2 overlay, then the session is dropped after the overlay degrades.
    if (s.overlayTimer) this.clock.clearTimeout(s.overlayTimer);
    if (s.idleTimer) this.clock.clearTimeout(s.idleTimer);
    s.baseState = "idle";
    s.overlay = "extra2";
    s.overlayTimer = this.clock.setTimeout(() => {
      // Drop the session record entirely; SessionEnd is terminal.
      this.sessions.delete(s.sessionId);
      this.recompute(this.clock.now());
    }, this.bootDurationMs);
    s.idleTimer = null; // no idle timer for a session that's about to be forgotten
    void now;
  }

  // ---------------------------------------------------------------------------
  // Internal: timer plumbing
  // ---------------------------------------------------------------------------

  private setOverlay(
    s: SessionRecord,
    overlay: OverlayState,
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
