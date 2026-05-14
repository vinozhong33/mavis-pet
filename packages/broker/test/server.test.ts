/**
 * Integration test — boots the real broker on an ephemeral port,
 * fires HTTP requests, asserts WS clients see the right messages.
 *
 * Uses RealClock (fast 50ms timers via custom config) instead of FakeClock
 * because HTTP+WS round-trips need the real event loop.
 */

import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { WebSocket } from "ws";
import { startBroker, type BrokerHandle } from "../src/server.js";
import { NullLogger } from "../src/logger.js";
import type { PetState, WsOutMessage, StatusSnapshot } from "../src/types.js";

let broker: BrokerHandle | null = null;

beforeEach(async () => {
  broker = await startBroker({
    host: "127.0.0.1",
    port: 0, // OS-assigned
    pet: null,
    logger: NullLogger,
    // Tighten timers for tests so we don't sit around for 30s.
    failedDegradeMs: 200,
    waveDurationMs: 100,
    idleAfterMs: 800,
    // Tests should not poll a real mavis daemon — disable the perm poller
    // and the SSE event-source consumer.
    disablePermPoller: true,
    disableEventSource: true,
    // v0.6.1 — disable sessions debouncing so direct broadcastSessions()
    // calls in tests flush immediately (no 100ms wait).
    sessionsDebounceMs: 0,
  });
});

afterEach(async () => {
  if (broker) {
    await broker.close();
    broker = null;
  }
});

function url(path: string): string {
  if (!broker) throw new Error("broker not running");
  return `http://${broker.host}:${broker.port}${path}`;
}

function wsUrl(path = "/ws"): string {
  if (!broker) throw new Error("broker not running");
  return `ws://${broker.host}:${broker.port}${path}`;
}

async function postEvent(body: unknown): Promise<Response> {
  return fetch(url("/event"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function getStatus(): Promise<StatusSnapshot> {
  const r = await fetch(url("/status"));
  return (await r.json()) as StatusSnapshot;
}

async function postSwitch(slug: string): Promise<Response> {
  return fetch(url("/switch"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug }),
  });
}

async function connectWs(): Promise<{
  ws: WebSocket;
  messages: WsOutMessage[];
  waitFor: (predicate: (m: WsOutMessage) => boolean, timeoutMs?: number) => Promise<WsOutMessage>;
  close: () => Promise<void>;
}> {
  const ws = new WebSocket(wsUrl());
  const messages: WsOutMessage[] = [];
  const waiters: Array<{
    predicate: (m: WsOutMessage) => boolean;
    resolve: (m: WsOutMessage) => void;
  }> = [];

  ws.on("message", (raw: Buffer) => {
    const m = JSON.parse(raw.toString("utf8")) as WsOutMessage;
    messages.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.predicate(m)) {
        const w = waiters.splice(i, 1)[0]!;
        w.resolve(m);
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });

  return {
    ws,
    messages,
    waitFor(predicate, timeoutMs = 2_000) {
      // Check existing buffered messages first.
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.findIndex((w) => w.predicate === predicate);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(
            new Error(
              `waitFor timeout after ${timeoutMs}ms; saw: ${JSON.stringify(messages)}`,
            ),
          );
        }, timeoutMs);
        waiters.push({
          predicate,
          resolve: (m) => {
            clearTimeout(timer);
            resolve(m);
          },
        });
      });
    },
    close: () =>
      new Promise<void>((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) return resolve();
        ws.once("close", () => resolve());
        ws.close();
      }),
  };
}

describe("broker HTTP + WS integration", () => {
  it("GET /status returns idle snapshot on cold start", async () => {
    const s = await getStatus();
    expect(s.state).toBe<PetState>("idle");
    expect(s.sessions).toEqual([]);
    expect(s.recentEvents).toEqual([]);
    expect(s.pet).toBeNull();
  });

  it("GET /healthz returns 200 ok", async () => {
    const r = await fetch(url("/healthz"));
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("ok");
  });

  it("WS client receives initial state on connect", async () => {
    const c = await connectWs();
    const first = await c.waitFor((m) => m.type === "state");
    expect(first).toEqual({ type: "state", state: "idle", ts: expect.any(Number) });
    await c.close();
  });

  it("PreToolUse → WS client sees state=run", async () => {
    const c = await connectWs();
    // Drain initial state push.
    await c.waitFor((m) => m.type === "state" && m.state === "idle");

    const r = await postEvent({ kind: "PreToolUse", sessionId: "s1" });
    expect(r.status).toBe(204);

    const m = await c.waitFor((m) => m.type === "state" && m.state === "run");
    expect(m).toMatchObject({ type: "state", state: "run", ts: expect.any(Number), activeSessionCount: 1 });
    await c.close();
  });

  it("PostToolUse failure → state=failed → degrades to run after 200ms", async () => {
    const c = await connectWs();
    await c.waitFor((m) => m.type === "state" && m.state === "idle");

    await postEvent({ kind: "PreToolUse", sessionId: "s1" });
    await c.waitFor((m) => m.type === "state" && m.state === "run");

    await postEvent({ kind: "PostToolUse", sessionId: "s1", exitCode: 1 });
    await c.waitFor((m) => m.type === "state" && m.state === "failed");

    // Should degrade back automatically.
    const back = await c.waitFor(
      (m) => m.type === "state" && (m.state === "run" || m.state === "idle"),
      2_000,
    );
    expect(["run", "idle"]).toContain((back as { state: PetState }).state);
    await c.close();
  });

  it("MessageComplete → state=wave → degrades", async () => {
    const c = await connectWs();
    await c.waitFor((m) => m.type === "state" && m.state === "idle");

    await postEvent({ kind: "MessageComplete", sessionId: "s1" });
    await c.waitFor((m) => m.type === "state" && m.state === "wave");

    // After waveDurationMs (100ms in tests), back to idle.
    await c.waitFor((m) => m.type === "state" && m.state === "idle");
    await c.close();
  });

  it("POST /switch broadcasts {type:'pet'} to clients", async () => {
    const c = await connectWs();
    await c.waitFor((m) => m.type === "state");

    const r = await postSwitch("boba");
    expect(r.status).toBe(200);

    const pet = await c.waitFor((m) => m.type === "pet");
    expect(pet).toEqual({ type: "pet", slug: "boba" });

    const s = await getStatus();
    expect(s.pet).toBe("boba");
    await c.close();
  });

  it("new client connecting after switch receives current pet", async () => {
    await postSwitch("dux");

    const c = await connectWs();
    const pet = await c.waitFor((m) => m.type === "pet");
    expect(pet).toEqual({ type: "pet", slug: "dux" });
    await c.close();
  });

  it("rejects invalid /event payload", async () => {
    const r1 = await postEvent({ kind: "Bogus", sessionId: "s1" });
    expect(r1.status).toBe(400);

    const r2 = await postEvent({ kind: "PreToolUse" });
    expect(r2.status).toBe(400);

    const r3 = await fetch(url("/event"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(r3.status).toBe(400);
  });

  it("unknown route returns 404", async () => {
    const r = await fetch(url("/nope"));
    expect(r.status).toBe(404);
  });

  it("/status reflects ingested events and ws client count", async () => {
    const c = await connectWs();
    await c.waitFor((m) => m.type === "state");

    await postEvent({ kind: "PreToolUse", sessionId: "s_a", tool: "bash" });
    await postEvent({ kind: "PreToolUse", sessionId: "s_b", tool: "bash" });

    // Wait for the run event so the recompute has happened.
    await c.waitFor((m) => m.type === "state" && m.state === "run");

    const s = await getStatus();
    expect(s.state).toBe("run");
    expect(s.sessions.length).toBe(2);
    expect(s.recentEvents.length).toBeGreaterThanOrEqual(2);
    expect(s.wsClients).toBeGreaterThanOrEqual(1);

    await c.close();
  });

  // Idempotence — N successive PreToolUse from the same session must produce
  // exactly ONE state push (run), not N. Floaters subscribe and would flicker
  // otherwise.
  it("idempotence: repeated PreToolUse on same session yields a single state push", async () => {
    const c = await connectWs();
    await c.waitFor((m) => m.type === "state" && m.state === "idle");

    // Snapshot how many state messages we have so far (just the initial idle).
    const beforeCount = c.messages.filter((m) => m.type === "state").length;
    expect(beforeCount).toBe(1);

    // Send 5 events back-to-back.
    for (let i = 0; i < 5; i++) {
      const r = await postEvent({ kind: "PreToolUse", sessionId: "same-s" });
      expect(r.status).toBe(204);
    }

    // We must see exactly ONE additional state push (idle → run); no flicker.
    await c.waitFor((m) => m.type === "state" && m.state === "run");

    // Give the server a beat to (incorrectly) flush more pushes if it would.
    await new Promise((r) => setTimeout(r, 100));

    const stateMsgs = c.messages.filter((m) => m.type === "state");
    expect(stateMsgs.length).toBe(beforeCount + 1);
    expect(stateMsgs.at(-1)).toMatchObject({ type: "state", state: "run" });

    await c.close();
  });

  // The PROTOCOL.md and README.md document /ws as the canonical path; the
  // server also accepts the bare root "/" for callers (like the floater) that
  // don't bother with a path. Lock that in.
  it("WS upgrade also works at root path /", async () => {
    const { WebSocket } = await import("ws");
    const ws = new WebSocket(`ws://${broker!.host}:${broker!.port}/`);

    // Attach listener BEFORE awaiting open — initial state push can arrive
    // before our open callback fires.
    const firstMessage = new Promise<unknown>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("no message in 2s")), 2_000);
      ws.once("message", (raw: Buffer) => {
        clearTimeout(t);
        resolve(JSON.parse(raw.toString("utf8")));
      });
      ws.once("error", (err) => {
        clearTimeout(t);
        reject(err);
      });
    });

    const got = await firstMessage;
    expect(got).toEqual({
      type: "state",
      state: "idle",
      ts: expect.any(Number),
    });

    await new Promise<void>((resolve) => {
      ws.once("close", () => resolve());
      ws.close();
    });
  });

  // WS upgrade on a path that is neither /ws nor / must NOT establish a
  // connection — we explicitly destroy the socket in server.ts.
  it("WS upgrade on unknown path is rejected", async () => {
    const { WebSocket } = await import("ws");
    const ws = new WebSocket(`ws://${broker!.host}:${broker!.port}/bogus`);
    const result = await new Promise<"open" | "error" | "close">((resolve) => {
      let settled = false;
      const settle = (v: "open" | "error" | "close") => {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      ws.once("open", () => settle("open"));
      ws.once("error", () => settle("error"));
      ws.once("close", () => settle("close"));
      setTimeout(() => settle("close"), 1_000);
    });
    expect(result).not.toBe("open");
    try {
      ws.terminate();
    } catch {
      // ignore
    }
  });

  // Graceful close: after broker.close() resolves, all sockets are closed and
  // /healthz is no longer reachable. This indirectly proves SIGTERM behavior
  // (CLI signal handler also calls handle.close()).
  it("close() shuts down WS clients and stops accepting HTTP", async () => {
    const c = await connectWs();
    await c.waitFor((m) => m.type === "state");

    // Capture broker before nulling it (afterEach also calls close, but we
    // need to invoke it ourselves to assert post-shutdown behavior).
    const localBroker = broker!;
    broker = null; // tell afterEach hook to skip its own close

    const closedPromise = new Promise<void>((resolve) =>
      c.ws.once("close", () => resolve()),
    );

    await localBroker.close();

    // WS must have been closed by the server.
    await closedPromise;

    // HTTP must refuse new requests — fetch should reject.
    let threw = false;
    try {
      await fetch(`http://${localBroker.host}:${localBroker.port}/healthz`);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  // v0.4 — task-card protocol smoke tests. Verifies:
  //  - Transient overlay states (failed, jump, wave, extra1, extra2) carry
  //    title + subtitle + (sometimes) loading on the WS message.
  //  - Sticky review state carries loading=true and NO bubbleTtlMs (sticky).
  //  - Idle/run still emit bare {type, state, ts} (no card; need real session
  //    data from SSE in v0.4.1+).
  it("v0.4 — MessageComplete pushes WAVE card with title/subtitle", async () => {
    const c = await connectWs();
    await c.waitFor((m) => m.type === "state" && m.state === "idle");

    await postEvent({ kind: "MessageComplete", sessionId: "s1" });
    const wave = await c.waitFor((m) => m.type === "state" && m.state === "wave");

    expect(wave).toMatchObject({
      type: "state",
      state: "wave",
      loading: false,
    });
    // v0.4.2 — stub copy ("Done"/"完成 ✓") removed to avoid misleading users
    // when no real SSE session data is available. Card stays empty unless the
    // event-source pool has a real session title/lastMessage.
    expect(wave).not.toHaveProperty("title");
    expect(wave).not.toHaveProperty("subtitle");
    // Wave is transient — even without a card, the state push has no TTL
    // because there's no bubble to dismiss; floater handles wave's own
    // animation timing via the state machine.
    await c.close();
  });

  it("v0.4.2 — PermissionRequested pushes REVIEW state with waiting=true and NO TTL (sticky)", async () => {
    const c = await connectWs();
    await c.waitFor((m) => m.type === "state" && m.state === "idle");

    await postEvent({ kind: "PermissionRequested", sessionId: "s1" });
    const review = await c.waitFor((m) => m.type === "state" && m.state === "review");

    // v0.4.2 split: review = `waiting` (clock icon), not `loading` (spinner).
    // The two are mutually exclusive — review means "blocked on user", which
    // is semantically distinct from "actively running".
    expect(review).toMatchObject({
      type: "state",
      state: "review",
      waiting: true,
    });
    // Stub copy removed (see DEFAULT_CARDS comment) — card empty unless SSE.
    expect(review).not.toHaveProperty("title");
    expect(review).not.toHaveProperty("subtitle");
    // loading not asserted — review takes the sticky-bubble fallback branch
    // when no card and no SSE data, which doesn't include `loading` (only
    // `waiting`, since loading is implied false for sticky review state).
    // Sticky — must NOT carry a TTL (undefined or absent).
    expect((review as { bubbleTtlMs?: number }).bubbleTtlMs).toBeUndefined();
    await c.close();
  });

  it("v0.4.2 — RUN state carries activeSessionCount + loading=true (no SSE-driven title yet)", async () => {
    const c = await connectWs();
    await c.waitFor((m) => m.type === "state" && m.state === "idle");

    await postEvent({ kind: "PreToolUse", sessionId: "s1" });
    const run = await c.waitFor((m) => m.type === "state" && m.state === "run");

    // No title / subtitle / bubble (run intentionally has no default card —
    // needs real SSE-driven data, which the test broker has disabled).
    // v0.4.2: DOES carry loading=true (spinner) + activeSessionCount=1 (badge).
    expect(run).toMatchObject({
      type: "state",
      state: "run",
      ts: expect.any(Number),
      activeSessionCount: 1,
      loading: true,
      waiting: false,
    });
    expect(run).not.toHaveProperty("title");
    expect(run).not.toHaveProperty("subtitle");
    expect(run).not.toHaveProperty("bubble");
    await c.close();
  });

  // v0.6.1 — sessions broadcast smoke tests. Verifies the new
  // {type:"sessions", sessions: SessionCard[]} message variant.
  // disableEventSource:true means there's no real SSE pool, so we drive
  // the hub directly via broker.hub.broadcastSessions(...) — that lets us
  // test the WS schema without spinning up a fake daemon.
  it("v0.6.1 — new client receives initial empty sessions snapshot on connect", async () => {
    const c = await connectWs();
    const initial = await c.waitFor((m) => m.type === "sessions");
    // disableEventSource:true → getCurrentSessions returns []
    // (server.ts ternary: `eventSource ? eventSource.getSessionCards() : []`).
    expect(initial).toEqual({ type: "sessions", sessions: [] });
    await c.close();
  });

  it("v0.6.1 — broadcastSessions pushes {type:'sessions'} with full SessionCard array", async () => {
    const c = await connectWs();
    // Drain initial state + sessions.
    await c.waitFor((m) => m.type === "state");
    await c.waitFor((m) => m.type === "sessions");

    broker!.hub.broadcastSessions([
      {
        sessionId: "sess-A",
        agentName: "mavis健康",
        title: "测试任务 A",
        currentAction: "正在思考",
        status: "started",
        lastEventTs: 1_700_000_000_000,
        deeplink: "minimax-cn-test://chat?chat_id=sess-A",
      },
      {
        sessionId: "sess-B",
        title: "Bug 修复",
        lastMessage: "已经定位到根因，准备开始修",
        status: "started",
        lastEventTs: 1_700_000_001_000,
      },
    ]);

    const msg = await c.waitFor(
      (m) =>
        m.type === "sessions" &&
        Array.isArray((m as { sessions: unknown[] }).sessions) &&
        (m as { sessions: unknown[] }).sessions.length === 2,
    );
    expect(msg).toMatchObject({
      type: "sessions",
      sessions: [
        {
          sessionId: "sess-A",
          agentName: "mavis健康",
          title: "测试任务 A",
          currentAction: "正在思考",
          status: "started",
          lastEventTs: 1_700_000_000_000,
          deeplink: "minimax-cn-test://chat?chat_id=sess-A",
        },
        {
          sessionId: "sess-B",
          title: "Bug 修复",
          lastMessage: "已经定位到根因，准备开始修",
          status: "started",
          lastEventTs: 1_700_000_001_000,
        },
      ],
    });
    await c.close();
  });

  it("v0.6.1 — broadcastSessions([]) clears floater card stack", async () => {
    const c = await connectWs();
    await c.waitFor((m) => m.type === "sessions");

    broker!.hub.broadcastSessions([
      { sessionId: "tmp", status: "started", lastEventTs: 1 },
    ]);
    await c.waitFor(
      (m) =>
        m.type === "sessions" &&
        (m as { sessions: unknown[] }).sessions.length === 1,
    );

    broker!.hub.broadcastSessions([]);
    const cleared = await c.waitFor(
      (m) =>
        m.type === "sessions" &&
        (m as { sessions: unknown[] }).sessions.length === 0,
    );
    expect(cleared).toEqual({ type: "sessions", sessions: [] });
    await c.close();
  });

  it("v0.6.1 — finished session card carries finishedAt for floater fade-out semantics", async () => {
    const c = await connectWs();
    await c.waitFor((m) => m.type === "sessions");

    broker!.hub.broadcastSessions([
      {
        sessionId: "sess-done",
        title: "Finished task",
        status: "finished",
        lastEventTs: 1_700_000_005_000,
        finishedAt: 1_700_000_005_000,
      },
    ]);

    const msg = await c.waitFor(
      (m) =>
        m.type === "sessions" &&
        (m as { sessions: { sessionId?: string }[] }).sessions[0]?.sessionId ===
          "sess-done",
    );
    expect(msg).toMatchObject({
      type: "sessions",
      sessions: [
        {
          sessionId: "sess-done",
          status: "finished",
          finishedAt: 1_700_000_005_000,
        },
      ],
    });
    await c.close();
  });

  it("v0.6.1 — waiting_perm currentAction surfaces on SessionCard", async () => {
    const c = await connectWs();
    await c.waitFor((m) => m.type === "sessions");

    broker!.hub.broadcastSessions([
      {
        sessionId: "sess-perm",
        title: "Bash command needs approval",
        currentAction: "等待审批",
        status: "started",
        lastEventTs: 1_700_000_010_000,
      },
    ]);

    const msg = await c.waitFor(
      (m) =>
        m.type === "sessions" &&
        (m as { sessions: { sessionId?: string }[] }).sessions[0]?.sessionId ===
          "sess-perm",
    );
    expect(msg).toMatchObject({
      type: "sessions",
      sessions: [
        {
          sessionId: "sess-perm",
          currentAction: "等待审批",
          status: "started",
        },
      ],
    });
    await c.close();
  });
});
