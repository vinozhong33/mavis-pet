/**
 * Clock abstraction — lets tests advance virtual time deterministically.
 *
 * Production uses {@link RealClock} (wraps `Date.now` + `setTimeout`).
 * Tests use {@link FakeClock} which keeps an internal queue of pending
 * callbacks and advances them when {@link FakeClock.advance} is called.
 *
 * The state machine and timers must NEVER call `Date.now()` or `setTimeout`
 * directly — always go through this interface.
 */

export type TimerHandle = { id: number };

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/** Real wall-clock implementation. */
export class RealClock implements Clock {
  private nextId = 1;
  private map = new Map<number, NodeJS.Timeout>();

  now(): number {
    return Date.now();
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.nextId++;
    const t = setTimeout(() => {
      this.map.delete(id);
      fn();
    }, ms);
    // Keep timer non-blocking — broker shouldn't keep the event loop alive
    // just because of a degrade timer.
    if (typeof t.unref === "function") t.unref();
    this.map.set(id, t);
    return { id };
  }

  clearTimeout(handle: TimerHandle): void {
    const t = this.map.get(handle.id);
    if (t) {
      clearTimeout(t);
      this.map.delete(handle.id);
    }
  }
}

/** In-memory virtual clock for tests. */
export class FakeClock implements Clock {
  private current: number;
  private nextId = 1;
  private pending: Array<{
    id: number;
    fireAt: number;
    fn: () => void;
  }> = [];

  constructor(startMs = 1_700_000_000_000) {
    this.current = startMs;
  }

  now(): number {
    return this.current;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.nextId++;
    this.pending.push({ id, fireAt: this.current + ms, fn });
    return { id };
  }

  clearTimeout(handle: TimerHandle): void {
    this.pending = this.pending.filter((p) => p.id !== handle.id);
  }

  /**
   * Advance virtual time by `ms`. Fires any timers whose deadline falls
   * within the new time window, in chronological order. Timers added
   * during a callback are honored if their deadline still falls within
   * the advance window.
   */
  advance(ms: number): void {
    const target = this.current + ms;
    while (true) {
      // Find the earliest pending timer that fires at-or-before target.
      let nextIdx = -1;
      let nextFireAt = Infinity;
      for (let i = 0; i < this.pending.length; i++) {
        const p = this.pending[i]!;
        if (p.fireAt <= target && p.fireAt < nextFireAt) {
          nextFireAt = p.fireAt;
          nextIdx = i;
        }
      }
      if (nextIdx === -1) break;
      const p = this.pending.splice(nextIdx, 1)[0]!;
      this.current = p.fireAt;
      p.fn();
    }
    this.current = target;
  }

  /** Number of pending timers — useful for assertions. */
  get pendingCount(): number {
    return this.pending.length;
  }
}
