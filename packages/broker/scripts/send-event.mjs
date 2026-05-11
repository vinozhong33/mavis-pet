/**
 * Tiny event injector — POST a single hook event to the broker.
 *
 * Used by:
 *   - scripts/verify.sh
 *   - manual debug (`node scripts/send-event.mjs PreToolUse demo`)
 *
 * Usage:
 *   node scripts/send-event.mjs <kind> <sessionId> [exitCode] [--port=N] [--tool=NAME]
 *
 * Examples:
 *   node scripts/send-event.mjs PreToolUse demo --port=17857 --tool=bash
 *   node scripts/send-event.mjs PostToolUse demo 1 --port=17857
 *   node scripts/send-event.mjs MessageComplete demo
 *
 * Exits 0 on 204, non-zero otherwise (with body printed to stderr).
 */

const args = process.argv.slice(2);
const positional = [];
let port = 17857;
let tool = undefined;

for (const a of args) {
  if (a.startsWith("--port=")) port = Number(a.slice("--port=".length));
  else if (a.startsWith("--tool=")) tool = a.slice("--tool=".length);
  else positional.push(a);
}

const [kind, sessionId, exitCodeStr] = positional;
if (!kind || !sessionId) {
  process.stderr.write(
    "usage: node scripts/send-event.mjs <kind> <sessionId> [exitCode] [--port=N] [--tool=NAME]\n",
  );
  process.exit(2);
}

const body = { kind, sessionId };
if (exitCodeStr !== undefined) body.exitCode = Number(exitCodeStr);
if (tool !== undefined) body.tool = tool;

const url = `http://127.0.0.1:${port}/event`;
const r = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

if (r.status !== 204) {
  const text = await r.text();
  process.stderr.write(`POST ${url} → ${r.status}\n${text}\n`);
  process.exit(1);
}
process.exit(0);
