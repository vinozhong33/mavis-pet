/**
 * Manual smoke test — connect a WS client, fire HTTP events, print message log.
 * Used by README and verifier.
 *
 * Usage: node scripts/ws-smoke.mjs [port]
 */

import { WebSocket } from "ws";

const port = Number(process.argv[2] ?? 17858);
const host = "127.0.0.1";

function postEvent(body) {
  return fetch(`http://${host}:${port}/event`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function main() {
  const ws = new WebSocket(`ws://${host}:${port}/ws`);
  const log = (label, m) =>
    process.stderr.write(`[${new Date().toISOString()}] ${label} ${JSON.stringify(m)}\n`);

  ws.on("open", () => log("open", { host, port }));
  ws.on("message", (raw) => log("recv", JSON.parse(raw.toString("utf8"))));
  ws.on("close", () => log("close", {}));
  ws.on("error", (e) => log("error", { msg: e.message }));

  // Sequence: PreToolUse → wait → PostToolUse(fail) → wait → MessageComplete → wait
  await new Promise((r) => setTimeout(r, 300));
  await postEvent({ kind: "PreToolUse", sessionId: "smoke", tool: "bash" });
  await new Promise((r) => setTimeout(r, 300));
  await postEvent({ kind: "PostToolUse", sessionId: "smoke", exitCode: 1 });
  await new Promise((r) => setTimeout(r, 2_500));
  await postEvent({ kind: "MessageComplete", sessionId: "smoke" });
  await new Promise((r) => setTimeout(r, 1_500));

  ws.close();
  await new Promise((r) => setTimeout(r, 100));
}

main().catch((err) => {
  process.stderr.write(`smoke test failed: ${err.message}\n`);
  process.exit(1);
});
