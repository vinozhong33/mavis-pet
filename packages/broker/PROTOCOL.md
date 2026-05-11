# Mavis Pet Broker — Protocol Specification (v0)

> Wire protocol for the broker process. Authoritative for any client
> (mavis hooks, the floater, third-party integrations).

The broker speaks two protocols on the same TCP port:

- **HTTP** — inbound hook events + admin/management endpoints
- **WebSocket** (mounted at `/ws`) — outbound state pushes to floaters

Default bind: `127.0.0.1:7857` (loopback only, no auth — broker is an
in-machine convenience daemon, not a network service).

---

## 1. HTTP API

All request/response bodies are `application/json; charset=utf-8` unless
noted otherwise. Body size is capped at **64 KiB** for `POST` endpoints.

### 1.1 `POST /event` — receive a hook event

Body schema:

```jsonc
{
  "kind":      "PreToolUse" | "PostToolUse" | "MessageComplete",  // required
  "sessionId": "ses_xxx" | "mvs_xxx",                              // required, non-empty string
  "tool":      "bash",                                              // optional, string
  "exitCode":  0,                                                   // optional, number (PostToolUse only)
  "ts":        1700000000000                                        // optional, unix ms; defaults to broker's clock.now()
}
```

Responses:

| Status | Meaning                                  |
|--------|-------------------------------------------|
| `204`  | Event accepted and applied                |
| `400`  | Invalid payload (`{"error":"...","..."}`) |
| `500`  | Broker internal error                     |

Notes:
- `PostToolUse` with **no** `exitCode` or `exitCode === 0` is treated as **success**.
- Non-zero `exitCode` → that session enters `failed`.
- Hook senders are encouraged but not required to set `ts`. When omitted,
  the broker stamps using its own clock.

### 1.2 `GET /status` — broker snapshot

Returns the aggregated runtime view. Useful for debugging and for the CLI
`mavis-pet status` subcommand.

```jsonc
{
  "state":   "failed" | "run" | "wave" | "idle",
  "pet":     "boba" | null,
  "ts":      1700000000000,
  "sessions": [
    {
      "sessionId":     "mvs_abc",
      "state":         "run",
      "lastEventTs":   1700000000000,
      "lastEventKind": "PreToolUse"
    }
  ],
  "recentEvents": [   // newest first, up to 10
    { "kind": "PostToolUse", "sessionId": "mvs_abc", "exitCode": 1, "ts": 170000... },
    { "kind": "PreToolUse",  "sessionId": "mvs_abc", "tool": "bash", "ts": 170000... }
  ],
  "uptimeMs":   12345,
  "wsClients":  2
}
```

### 1.3 `POST /switch` — change active pet slug

Body:

```jsonc
{ "slug": "boba" }
```

Responses:

| Status | Body                          |
|--------|-------------------------------|
| `200`  | `{"ok":true,"slug":"boba"}`   |
| `400`  | `{"error":"invalid_slug"}`    |

Side effect: every connected WS client receives `{"type":"pet","slug":"boba"}`
immediately.

### 1.4 `GET /healthz` — liveness probe

Returns `200 OK` with the body `ok` (text/plain). Cheap; safe for tight polling.

### 1.5 Errors and unknown routes

- Unknown route → `404 {"error":"not_found","path":"<path>"}`
- Method/route mismatch → `404` (no special-casing of `405`)
- Body too large or invalid JSON → `400 {"error":"invalid_json"}` /
  `{"error":"expected_object"}` / `{"error":"invalid_kind"}` /
  `{"error":"invalid_sessionId"}`

---

## 2. WebSocket API (path `/ws`)

Plain JSON text frames. The server **does not** require any subprotocol or
auth handshake — connecting is enough.

### 2.1 On connect

The broker pushes a snapshot in this order, **before** delivering live events:

1. `{"type":"state","state":"<current>","ts":<ms>}` — always sent
2. `{"type":"pet","slug":"<current>"}` — only if a pet is currently active

This means a fresh client never has to call `GET /status` to render correctly.

### 2.2 Server → Client messages

```jsonc
{ "type": "state", "state": "run" | "idle" | "wave" | "failed", "ts": 1700000000000 }
```

```jsonc
{ "type": "pet", "slug": "boba" }
```

Future message types are additive — clients **must** ignore unknown `type`
values rather than crash.

### 2.3 Client → Server messages

None are required or honored by v0. The broker is push-only. Clients **may**
still send `ping` frames to keep the TCP connection warm; the server
responds with `pong` automatically (handled by `ws`).

### 2.4 Push semantics

- Broker pushes a `state` message **only when the aggregated global state
  actually changes**. It will not flood with redundant `run → run`
  transitions.
- Broker pushes `pet` immediately on every `POST /switch`, even if the slug
  is the same as the current one — clients can use it as a "force reload".
- All clients receive the same broadcast at roughly the same time. There
  is no per-client filtering.

---

## 3. State Machine

### 3.1 Per-session model

Each `sessionId` carries:

- A **base state**: either `run` or `idle`.
- An optional **overlay**: `failed` or `wave`, with a degrade timer.

Per-session transitions:

| Inbound event                    | Effect                                      |
|----------------------------------|---------------------------------------------|
| `PreToolUse`                     | base = `run`; clear `wave` overlay if any   |
| `PostToolUse`, exit `0`/missing  | base = `run`; clear `wave` overlay if any   |
| `PostToolUse`, exit non-zero     | base = `run`; set `failed` overlay (2 s)    |
| `MessageComplete`                | base = `idle`; set `wave` overlay (1 s)     |

Plus two global timers per session:

- **silence** — every event arms a `30 s` timer; on expiry the session's
  `base` becomes `idle`. (Default 30 s; configurable via `idleAfterMs`.)
- **overlay degrade** — set together with the overlay; on expiry the
  overlay is cleared.

`failed` is **not** cleared by subsequent `PreToolUse` or `PostToolUse`
events; only the timer drops it. This is intentional — the FAILED signal
must be visible for at least its full duration.

### 3.2 Global aggregation

Each event triggers a recompute. The broker scans every session, picks the
strongest contribution, and emits a state push **only if** the result
changes.

Priority (higher wins):

```
failed (4)  >  run (3)  >  wave (2)  >  idle (1)
```

Examples:

| Sessions                            | Global   |
|-------------------------------------|----------|
| `s1=run`, `s2=idle`                 | `run`    |
| `s1=run`, `s2=failed`               | `failed` |
| `s1=wave`, `s2=idle`                | `wave`   |
| `s1=run`, `s2=wave`                 | `run`    |
| (no sessions)                       | `idle`   |
| (all sessions silent for 30 s)      | `idle`   |

### 3.3 Diagram

```
┌─────────────────────── PER-SESSION ────────────────────────┐
│                                                            │
│   ┌────────┐  PreToolUse / PostToolUse(ok)   ┌──────────┐  │
│   │ idle   │ ──────────────────────────────► │ run      │  │
│   │ (base) │                                  │ (base)   │  │
│   └────────┘ ◄──────── 30s silence ────────── └──────────┘  │
│                                                  │  ▲      │
│                                                  │  │      │
│                                  PostToolUse(!0) ▼  │ +2s  │
│                                              ┌──────────┐  │
│                                              │ failed*  │──┘
│                                              │ overlay  │
│                                              └──────────┘
│                                                            │
│                       MessageComplete                      │
│   ┌────────┐ ─────────────────────► ┌──────────┐           │
│   │ any    │                        │ wave*    │ +1s       │
│   │ base   │                        │ overlay  │ ─► clear  │
│   └────────┘                        └──────────┘           │
└────────────────────────────────────────────────────────────┘

Global = max( per-session effective state ) by priority
        FAILED > RUN > WAVE > IDLE
```

`*` overlays sit on top of the base state. While an overlay is active it
defines the per-session contribution to the global aggregation; once the
overlay timer drops, the base resurfaces.

### 3.4 Configurable timers

| Knob               | Default | ENV (n/a — set in code) |
|--------------------|---------|--------------------------|
| `failedDegradeMs`  | 2000    | passed via `BrokerOptions` |
| `waveDurationMs`   | 1000    | passed via `BrokerOptions` |
| `idleAfterMs`      | 30000   | passed via `BrokerOptions` |

The CLI does not expose these for v0 — they are used in tests only.

---

## 4. Determinism guarantees

- All timers are routed through an injected `Clock` interface. Production
  uses `RealClock`; tests use `FakeClock` to advance virtual time.
- Listeners are invoked synchronously inside `ingest()` or inside a timer
  callback. There is no microtask/queue indirection.
- Listener exceptions are swallowed — a buggy subscriber cannot break the
  state machine.

---

## 5. Constraints

- **No persistence in v0.** A broker restart resets everything to `idle`.
- **No auth.** Bind only to `127.0.0.1`.
- **stdout is reserved.** All structured logs go to stderr; the broker
  must never write to `stdout` so callers can pipe `curl` / JSON safely.
- **No external state writes.** The broker reads no files at runtime in v0.
