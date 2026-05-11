# `@mavis-pet/broker`

Independent Node.js broker that bridges **mavis hook events** (HTTP) to
**desktop pet floaters** (WebSocket). Maintains a per-session state
machine, aggregates a single global "pet animation state", and pushes
changes to all connected floaters.

For the wire format and state semantics see [`PROTOCOL.md`](./PROTOCOL.md).

---

## Why a separate process

- mavis hooks are **fire-and-forget shell scripts**; they cannot hold
  state across invocations.
- The pet is a **session-aware** signal: it should stay `run` while *any*
  session has a pending tool, drop to `idle` only after silence.
- Keeping the broker out of `mavis daemon` means the pet can crash, restart,
  or be uninstalled without touching the agent runtime.

---

## Install / build

```bash
cd broker/
npm install
npm run build       # → dist/index.js, dist/main.js, .d.ts
```

Node 18+ required (uses native `fetch` in tests, ESM, top-level await).

---

## Run

```bash
# Defaults: bind 127.0.0.1:7857, no active pet
node bin/mavis-pet-broker.mjs

# Or after `npm install -g .`
mavis-pet-broker --port 7857 --pet boba

# Help
mavis-pet-broker --help
```

CLI flags (override env):

| Flag             | Env                       | Default        |
|------------------|---------------------------|----------------|
| `--host`         | `MAVIS_PET_BROKER_HOST`   | `127.0.0.1`    |
| `--port`         | `MAVIS_PET_BROKER_PORT`   | `7857`         |
| `--pet`          | `MAVIS_PET_DEFAULT_PET`   | _(none)_       |
| `--log-level`    | `MAVIS_PET_LOG_LEVEL`     | `info`         |
| `--quiet`        | (shortcut)                | `--log-level warn` |
| `--help` / `-h`  | —                         | print usage    |

stdout is reserved — all logs go to **stderr**. The CLI prints exactly
one bind line on stderr at startup:

```
mavis-pet-broker listening on http://127.0.0.1:7857 (ws path: /ws)
```

---

## Endpoints

```
POST http://<host>:<port>/event       # mavis hook → broker
GET  http://<host>:<port>/status      # debug snapshot
POST http://<host>:<port>/switch      # change active pet (body: {"slug":"..."})
GET  http://<host>:<port>/healthz     # liveness probe
WS   ws://<host>:<port>/ws            # floater push channel
```

Full schema and sample payloads in [`PROTOCOL.md`](./PROTOCOL.md).

---

## Quickstart — debugging by hand

Terminal A — start broker:

```bash
node bin/mavis-pet-broker.mjs --port 17857 2>broker.stderr
# (broker stays in foreground; stderr lines stream into broker.stderr)
```

Terminal B — connect a WS client:

```bash
# wscat is convenient if installed (npm i -g wscat)
wscat -c ws://127.0.0.1:17857/ws
# you should immediately see: {"type":"state","state":"idle","ts":...}
```

Terminal C — inject events:

```bash
curl -i -X POST http://127.0.0.1:17857/event \
  -H 'content-type: application/json' \
  -d '{"kind":"PreToolUse","sessionId":"demo","tool":"bash"}'
# wscat shows: {"type":"state","state":"run",...}

curl -X POST http://127.0.0.1:17857/event \
  -H 'content-type: application/json' \
  -d '{"kind":"PostToolUse","sessionId":"demo","exitCode":1}'
# wscat shows: {"type":"state","state":"failed",...}
# 2 s later:
# wscat shows: {"type":"state","state":"run",...}

curl -X POST http://127.0.0.1:17857/event \
  -H 'content-type: application/json' \
  -d '{"kind":"MessageComplete","sessionId":"demo"}'
# wscat shows: {"type":"state","state":"wave",...}
# 1 s later (with no other events):
# wscat shows: {"type":"state","state":"idle",...}   (after silence threshold)

curl -X POST http://127.0.0.1:17857/switch \
  -H 'content-type: application/json' \
  -d '{"slug":"boba"}'
# wscat shows: {"type":"pet","slug":"boba"}

curl http://127.0.0.1:17857/status | jq
# full snapshot including session table & last 10 events
```

If you don't have `wscat`, the bundled smoke script does the same end-to-end
in one shot:

```bash
node bin/mavis-pet-broker.mjs --port 17858 2>/dev/null &
node scripts/ws-smoke.mjs 17858    # logs every WS message it receives
kill %1
```

---

## Tests

```bash
npm test          # run vitest once
npm run test:watch
npm run typecheck
```

Coverage:
- `test/state-machine.test.ts` — 17 cases on the pure state machine
  (uses `FakeClock` to assert deterministic time behavior).
- `test/server.test.ts` — 11 cases booting a real HTTP+WS server on an
  ephemeral port, fires real events, asserts pushes.
- `test/logger.test.ts` — level filtering + disabled mode.

The 5 mandatory scenarios from the task brief are covered by:

| Scenario                                                    | Test |
|-------------------------------------------------------------|------|
| `PreToolUse` → `run`                                         | `state-machine.test.ts:single session: PreToolUse → state=run` |
| `PostToolUse` failure → `failed`, 2 s degrade                | `state-machine.test.ts:single session: PostToolUse failure → state=failed, degrades after 2s` |
| Multi-session: one running + one idle → global `run`         | `state-machine.test.ts:multi-session: one RUNNING + one IDLE → global RUNNING` |
| 30 s silence → `idle`                                        | `state-machine.test.ts:30s silence → state=idle` |
| `MessageComplete` → `wave` for 1 s                           | `state-machine.test.ts:MessageComplete → WAVE for 1s, then degrades` |

---

## Architecture

```
src/
├── types.ts           public type contracts (events, snapshots, ws messages)
├── clock.ts           Clock interface + RealClock + FakeClock
├── logger.ts          stderr logger with level filtering
├── state-machine.ts   per-session state, aggregation, listeners
├── http.ts            POST /event, GET /status, POST /switch handlers
├── ws.ts              WebSocket hub (broadcasts state + pet)
├── server.ts          startBroker(): wires everything together
├── main.ts            CLI entry (parseArgs, signal handling)
└── index.ts           public package exports

bin/
└── mavis-pet-broker.mjs   bin shim — loads dist/main.js (or src via tsx in dev)

test/
├── state-machine.test.ts
├── server.test.ts
└── logger.test.ts

scripts/
└── ws-smoke.mjs       end-to-end smoke test (also handy for manual debug)
```

Every timer in the state machine is routed through `Clock.setTimeout` so
tests can advance virtual time deterministically. Production uses
`RealClock`, which `unref()`s its timers so the broker does not keep the
event loop alive solely on a degrade timer.

---

## v0 limitations

- **No persistence.** Restart = blank slate.
- **No auth.** Bind to `127.0.0.1` only.
- **No multi-broker leader election.** Run exactly one broker per host.
- Hook senders may set `ts` for accuracy across processes; if omitted,
  the broker stamps with `Date.now()`.

See `~/.mavis/.../workspace/roadmap-mavis-pet.md` for what's deliberately
out-of-scope.

---

## License

MIT (project-internal).
