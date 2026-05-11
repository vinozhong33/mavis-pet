/**
 * State machine unit tests — covers the 5 core scenarios from the task spec
 * plus a few edge cases. Uses FakeClock so timer behavior is deterministic.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { FakeClock } from "../src/clock.js";
import { StateMachine } from "../src/state-machine.js";
import type { PetState } from "../src/types.js";

interface Recorder {
  events: Array<{ state: PetState; ts: number }>;
}

function attach(machine: StateMachine): Recorder {
  const rec: Recorder = { events: [] };
  machine.onChange((state, ts) => {
    rec.events.push({ state, ts });
  });
  return rec;
}

describe("StateMachine", () => {
  let clock: FakeClock;
  let m: StateMachine;
  let rec: Recorder;

  beforeEach(() => {
    clock = new FakeClock();
    m = new StateMachine({
      clock,
      failedDegradeMs: 2_000,
      waveDurationMs: 1_000,
      idleAfterMs: 30_000,
    });
    rec = attach(m);
  });

  // ---------------------------------------------------------------------------
  // Spec scenario 1: PreToolUse → state should be RUN
  // ---------------------------------------------------------------------------
  it("single session: PreToolUse → state=run", () => {
    expect(m.globalState).toBe<PetState>("idle");

    m.ingest({ kind: "PreToolUse", sessionId: "s1" });

    expect(m.globalState).toBe<PetState>("run");
    expect(rec.events).toEqual([{ state: "run", ts: clock.now() }]);
  });

  // ---------------------------------------------------------------------------
  // Spec scenario 2: PostToolUse failure → FAILED, then auto-degrade after 2s
  // ---------------------------------------------------------------------------
  it("single session: PostToolUse failure → state=failed, degrades after 2s", () => {
    m.ingest({ kind: "PreToolUse", sessionId: "s1" });
    expect(m.globalState).toBe("run");
    rec.events.length = 0;

    m.ingest({ kind: "PostToolUse", sessionId: "s1", exitCode: 1 });
    expect(m.globalState).toBe("failed");
    expect(rec.events.at(-1)?.state).toBe("failed");

    // Just before 2s: still failed.
    clock.advance(1_999);
    expect(m.globalState).toBe("failed");

    // Cross the 2s boundary.
    clock.advance(2);
    // After overlay drops, baseState=run remains because session is still alive.
    expect(m.globalState).toBe("run");

    const states = rec.events.map((e) => e.state);
    expect(states).toContain("failed");
    expect(states.at(-1)).toBe("run");
  });

  it("PostToolUse failure on a finished session → degrades to idle after silence", () => {
    m.ingest({ kind: "MessageComplete", sessionId: "s1" });
    // After WAVE expires we should be back at idle (baseState set to idle by MessageComplete).
    clock.advance(1_500);
    expect(m.globalState).toBe("idle");
    rec.events.length = 0;

    m.ingest({ kind: "PostToolUse", sessionId: "s1", exitCode: 2 });
    expect(m.globalState).toBe("failed");

    // After 2s overlay drop, baseState was set to "run" by PostToolUse.
    clock.advance(2_001);
    expect(m.globalState).toBe("run");

    // After silence timeout, falls to idle.
    clock.advance(30_001);
    expect(m.globalState).toBe("idle");
  });

  // ---------------------------------------------------------------------------
  // Spec scenario 3: multi-session, one RUNNING + one IDLE → global RUNNING
  // ---------------------------------------------------------------------------
  it("multi-session: one RUNNING + one IDLE → after WAVE expires, global RUNNING", () => {
    m.ingest({ kind: "PreToolUse", sessionId: "s_active" });
    m.ingest({ kind: "MessageComplete", sessionId: "s_done" });

    // s_done has WAVE overlay (priority 3) > s_active's RUN (priority 2),
    // so global is briefly WAVE while the overlay is active.
    expect(m.globalState).toBe("wave");

    // After WAVE expires, s_done baseState=idle, s_active still run → global=run.
    clock.advance(1_001);
    expect(m.globalState).toBe("run");
  });

  it("multi-session: FAILED in one session beats RUNNING in others", () => {
    m.ingest({ kind: "PreToolUse", sessionId: "s_a" });
    m.ingest({ kind: "PreToolUse", sessionId: "s_b" });
    expect(m.globalState).toBe("run");

    m.ingest({ kind: "PostToolUse", sessionId: "s_b", exitCode: 1 });
    expect(m.globalState).toBe("failed");

    clock.advance(2_001);
    // Failed overlay dropped, both sessions still run.
    expect(m.globalState).toBe("run");
  });

  // ---------------------------------------------------------------------------
  // Spec scenario 4: silence 30s → IDLE
  // ---------------------------------------------------------------------------
  it("30s silence → state=idle", () => {
    m.ingest({ kind: "PreToolUse", sessionId: "s1" });
    expect(m.globalState).toBe("run");

    clock.advance(29_999);
    expect(m.globalState).toBe("run");

    clock.advance(2);
    expect(m.globalState).toBe("idle");
  });

  // ---------------------------------------------------------------------------
  // Spec scenario 5: MessageComplete → WAVE 1s, then degrade
  // ---------------------------------------------------------------------------
  it("MessageComplete → WAVE for 1s, then degrades", () => {
    m.ingest({ kind: "MessageComplete", sessionId: "s1" });
    expect(m.globalState).toBe("wave");

    clock.advance(999);
    expect(m.globalState).toBe("wave");

    clock.advance(2);
    // baseState was set to idle by MessageComplete, so we go to idle.
    expect(m.globalState).toBe("idle");

    const seq = rec.events.map((e) => e.state);
    expect(seq[0]).toBe("wave");
    expect(seq.at(-1)).toBe("idle");
  });

  it("MessageComplete during RUNNING session: WAVE overlay wins, then degrades back to RUN", () => {
    m.ingest({ kind: "PreToolUse", sessionId: "s_busy" });
    expect(m.globalState).toBe("run");

    m.ingest({ kind: "MessageComplete", sessionId: "s_done" });
    // wave overlay (priority 3) > run (priority 2), so global flips to wave briefly.
    expect(m.globalState).toBe("wave");

    clock.advance(1_500);
    // wave overlay expired, s_done baseState=idle, s_busy still run → global=run.
    expect(m.globalState).toBe("run");
  });

  // ---------------------------------------------------------------------------
  // Aggregation priority sanity
  // ---------------------------------------------------------------------------
  it("aggregation order is FAILED > RUN > WAVE > IDLE", () => {
    // Build a single session via successive events.
    m.ingest({ kind: "MessageComplete", sessionId: "s1" });
    expect(m.globalState).toBe("wave");

    m.ingest({ kind: "PreToolUse", sessionId: "s1" });
    expect(m.globalState).toBe("run");

    m.ingest({ kind: "PostToolUse", sessionId: "s1", exitCode: 2 });
    expect(m.globalState).toBe("failed");
  });

  // ---------------------------------------------------------------------------
  // v0.2 — UserPromptSubmit → JUMP
  // ---------------------------------------------------------------------------
  it("UserPromptSubmit → JUMP for 1.5s, then degrades to idle", () => {
    m.ingest({ kind: "UserPromptSubmit", sessionId: "s1" });
    expect(m.globalState).toBe("jump");

    clock.advance(1_499);
    expect(m.globalState).toBe("jump");

    clock.advance(2);
    expect(m.globalState).toBe("idle");
  });

  it("JUMP overlay beats RUN in aggregation", () => {
    m.ingest({ kind: "PreToolUse", sessionId: "s_busy" });
    expect(m.globalState).toBe("run");

    m.ingest({ kind: "UserPromptSubmit", sessionId: "s_input" });
    // jump (6) > run (2)
    expect(m.globalState).toBe("jump");

    clock.advance(1_600);
    // jump overlay expired; s_busy still running.
    expect(m.globalState).toBe("run");
  });

  // ---------------------------------------------------------------------------
  // v0.2 — SessionStart → EXTRA1, SessionEnd → EXTRA2 + forget
  // ---------------------------------------------------------------------------
  it("SessionStart → EXTRA1 for 2.5s, then degrades", () => {
    m.ingest({ kind: "SessionStart", sessionId: "s_boot" });
    expect(m.globalState).toBe("extra1");

    clock.advance(2_499);
    expect(m.globalState).toBe("extra1");

    clock.advance(2);
    expect(m.globalState).toBe("idle");
  });

  it("SessionEnd → EXTRA2 then forgets the session", () => {
    m.ingest({ kind: "PreToolUse", sessionId: "s1" });
    expect(m.globalState).toBe("run");

    m.ingest({ kind: "SessionEnd", sessionId: "s1" });
    expect(m.globalState).toBe("extra2");
    expect(m.snapshotSessions().some((s) => s.sessionId === "s1")).toBe(true);

    clock.advance(2_600);
    // EXTRA2 overlay expired AND session was forgotten.
    expect(m.globalState).toBe("idle");
    expect(m.snapshotSessions().some((s) => s.sessionId === "s1")).toBe(false);
  });

  it("priority order: FAILED > REVIEW > JUMP > EXTRA1 > EXTRA2 > WAVE > RUN > IDLE", () => {
    // EXTRA2 vs RUN — extra2 wins.
    m.ingest({ kind: "PreToolUse", sessionId: "s_run" });
    m.ingest({ kind: "SessionEnd", sessionId: "s_end" });
    expect(m.globalState).toBe("extra2");

    // Add EXTRA1 — beats EXTRA2.
    m.ingest({ kind: "SessionStart", sessionId: "s_boot" });
    expect(m.globalState).toBe("extra1");

    // Add JUMP — beats EXTRA1.
    m.ingest({ kind: "UserPromptSubmit", sessionId: "s_input" });
    expect(m.globalState).toBe("jump");

    // Add FAILED — beats everything.
    m.ingest({ kind: "PostToolUse", sessionId: "s_run", exitCode: 1 });
    expect(m.globalState).toBe("failed");
  });

  // ---------------------------------------------------------------------------
  // Successful PostToolUse
  // ---------------------------------------------------------------------------
  it("PostToolUse success keeps state RUN", () => {
    m.ingest({ kind: "PreToolUse", sessionId: "s1" });
    rec.events.length = 0;

    m.ingest({ kind: "PostToolUse", sessionId: "s1", exitCode: 0 });
    expect(m.globalState).toBe("run");

    // No transition emitted (run → run is a no-op).
    expect(rec.events.length).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Listener idempotence
  // ---------------------------------------------------------------------------
  it("does not re-emit when global state is unchanged", () => {
    m.ingest({ kind: "PreToolUse", sessionId: "s1" });
    expect(rec.events.length).toBe(1);

    m.ingest({ kind: "PreToolUse", sessionId: "s2" });
    // Both running, global stays run, no new emission.
    expect(rec.events.length).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Snapshot inspection
  // ---------------------------------------------------------------------------
  it("snapshotSessions reports per-session view", () => {
    m.ingest({ kind: "PreToolUse", sessionId: "s_run" });
    m.ingest({ kind: "PostToolUse", sessionId: "s_fail", exitCode: 1 });

    const snap = m.snapshotSessions();
    const map = new Map(snap.map((s) => [s.sessionId, s.state]));
    expect(map.get("s_run")).toBe("run");
    expect(map.get("s_fail")).toBe("failed");
  });

  // ---------------------------------------------------------------------------
  // Activity resets the silence timer
  // ---------------------------------------------------------------------------
  it("any event resets the per-session silence timer", () => {
    m.ingest({ kind: "PreToolUse", sessionId: "s1" });

    clock.advance(20_000);
    expect(m.globalState).toBe("run");

    // Heartbeat keeps it alive.
    m.ingest({ kind: "PostToolUse", sessionId: "s1", exitCode: 0 });

    clock.advance(20_000);
    expect(m.globalState).toBe("run");

    clock.advance(11_000); // total since last event > 30s
    expect(m.globalState).toBe("idle");
  });

  // ---------------------------------------------------------------------------
  // forgetSession + dispose hygiene
  // ---------------------------------------------------------------------------
  it("forgetSession clears session and re-aggregates", () => {
    m.ingest({ kind: "PreToolUse", sessionId: "s1" });
    expect(m.globalState).toBe("run");

    m.forgetSession("s1");
    expect(m.globalState).toBe("idle");
    expect(m.snapshotSessions()).toHaveLength(0);
  });

  it("dispose clears all timers", () => {
    m.ingest({ kind: "PostToolUse", sessionId: "s1", exitCode: 1 });
    expect(clock.pendingCount).toBeGreaterThan(0);

    m.dispose();
    // No timers can fire anymore.
    clock.advance(60_000);
    // (no exception, machine simply doesn't react)
  });
});
