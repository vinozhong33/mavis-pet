/**
 * Long-running WS listener — connects to ws://127.0.0.1:<port>/ws and
 * prints every received frame to stdout in this exact format:
 *
 *   [<elapsed>s] connected to <url>
 *   [<elapsed>s] recv {"type":...}
 *   [<elapsed>s] closed code=<code> reason=<reason>
 *
 * Used by:
 *   - scripts/verify.sh    (e2e regression — captures and asserts message log)
 *   - manual debug         (you can tail /tmp/ws.log while curl-ing /event)
 *
 * Exits when the WS closes or on SIGINT.
 *
 * Usage: node scripts/ws-listener.mjs [port=17857] [path=/ws]
 */

import { WebSocket } from "ws";

const port = Number(process.argv[2] ?? 17857);
const path = process.argv[3] ?? "/ws";
const url = `ws://127.0.0.1:${port}${path}`;
const startedAt = Date.now();
const t = () => ((Date.now() - startedAt) / 1000).toFixed(3);

const ws = new WebSocket(url);

ws.on("open", () => process.stdout.write(`[${t()}s] connected to ${url}\n`));
ws.on("message", (raw) => {
  process.stdout.write(`[${t()}s] recv ${raw.toString("utf8")}\n`);
});
ws.on("close", (code, reason) => {
  process.stdout.write(
    `[${t()}s] closed code=${code} reason=${reason?.toString() ?? ""}\n`,
  );
  process.exit(0);
});
ws.on("error", (err) => {
  process.stderr.write(`[${t()}s] error ${err.message}\n`);
  process.exit(1);
});

process.on("SIGINT", () => {
  try {
    ws.close();
  } catch {}
});
process.on("SIGTERM", () => {
  try {
    ws.close();
  } catch {}
});
