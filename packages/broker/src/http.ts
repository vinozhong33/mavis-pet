/**
 * HTTP API:
 *   POST /event   — accept hook events, returns 204
 *   GET  /status  — broker snapshot (state, sessions, pet, recent events)
 *   POST /switch  — switch active pet slug; broadcasts {type:"pet"} over WS
 *   GET  /healthz — cheap liveness probe
 *
 * No framework — Node's `http` module is enough. JSON parsing is hand-rolled
 * with size cap to avoid pulling another dep (and to stay dependency-light).
 */

import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Clock } from "./clock.js";
import { type Logger, NullLogger } from "./logger.js";
import type { StateMachine } from "./state-machine.js";
import type { HookEvent, HookEventKind, StatusSnapshot } from "./types.js";

const MAX_BODY_BYTES = 64 * 1024; // 64 KiB — hook payloads are tiny.
const VALID_KINDS: ReadonlySet<HookEventKind> = new Set([
  "PreToolUse",
  "PostToolUse",
  "MessageComplete",
  "UserPromptSubmit",
  "SessionStart",
  "SessionEnd",
  "PermissionRequested",
  "PermissionResolved",
]);

/** Broadcaster contract — implemented by the WS hub. */
export interface Broadcaster {
  broadcastPet(slug: string): void;
  clientCount(): number;
}

export interface HttpDeps {
  machine: StateMachine;
  broadcaster: Broadcaster;
  clock: Clock;
  /** Bounded ring buffer of recent events for /status. */
  recentEvents: HookEvent[];
  /** Mutable container holding the active pet slug. */
  petRef: { slug: string | null };
  /** Process start ts for uptime. */
  startedAt: number;
  logger?: Logger;
  /**
   * v0.4.3 — fired after every successfully ingested hook event. broker
   * server.ts uses this to translate PreToolUse(tool) → live action verb
   * on the floater card subtitle. Optional so existing tests / callers
   * don't need to wire it up.
   */
  onHookEvent?: (event: HookEvent) => void;
  /**
   * v0.4.3 — fired when the floater POSTs /dismiss (user hover/click on
   * a done card). broker evicts the picked session immediately + re-broadcasts.
   */
  onDismissCard?: () => void;
}

export function createHttpHandler(deps: HttpDeps) {
  const log = deps.logger ?? NullLogger;

  return async function handler(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    try {
      if (method === "POST" && url === "/event") {
        await handleEvent(req, res, deps);
        return;
      }
      if (method === "GET" && url === "/status") {
        handleStatus(res, deps);
        return;
      }
      if (method === "POST" && url === "/switch") {
        await handleSwitch(req, res, deps);
        return;
      }
      // v0.4.3 — floater calls this on hover/click of a "done" card to
      // dismiss it (evict the session immediately + force re-broadcast so
      // the card disappears). No body required.
      if (method === "POST" && url === "/dismiss") {
        deps.onDismissCard?.();
        res.statusCode = 204;
        res.end();
        return;
      }
      if (method === "GET" && url === "/healthz") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
        return;
      }
      sendJson(res, 404, { error: "not_found", path: url });
    } catch (err) {
      log.error("http_handler_error", {
        url,
        method,
        message: (err as Error)?.message,
      });
      try {
        sendJson(res, 500, { error: "internal_error" });
      } catch {
        // response may already be written
      }
    }
  };
}

/** Boot a Node http server bound to the handler. */
export function startHttpServer(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void,
  host: string,
  port: number,
): Promise<{ server: HttpServer; address: AddressInfo }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      Promise.resolve(handler(req, res)).catch(() => {
        try {
          if (!res.headersSent) {
            res.writeHead(500);
            res.end();
          }
        } catch {
          // ignore
        }
      });
    });
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address() as AddressInfo;
      resolve({ server, address });
    });
  });
}

// -----------------------------------------------------------------------------
// Handlers
// -----------------------------------------------------------------------------

async function handleEvent(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpDeps,
): Promise<void> {
  const body = await readJsonBody(req);
  if (body === undefined) {
    sendJson(res, 400, { error: "invalid_json" });
    return;
  }
  if (typeof body !== "object" || body === null) {
    sendJson(res, 400, { error: "expected_object" });
    return;
  }
  const obj = body as Record<string, unknown>;

  const kind = obj.kind;
  const sessionId = obj.sessionId;
  if (typeof kind !== "string" || !VALID_KINDS.has(kind as HookEventKind)) {
    sendJson(res, 400, { error: "invalid_kind", got: kind });
    return;
  }
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    sendJson(res, 400, { error: "invalid_sessionId" });
    return;
  }

  const event: HookEvent = {
    kind: kind as HookEventKind,
    sessionId,
    tool: typeof obj.tool === "string" ? obj.tool : undefined,
    exitCode: typeof obj.exitCode === "number" ? obj.exitCode : undefined,
    ts: typeof obj.ts === "number" ? obj.ts : deps.clock.now(),
  };

  deps.machine.ingest(event);
  pushRecentEvent(deps.recentEvents, event);
  // v0.4.3 — broadcast PreToolUse → live action verb to event-source pool.
  // Maps tool name to short Chinese verb shown in the floater card subtitle
  // during a streaming turn (replaces the empty "no message yet" gap).
  deps.onHookEvent?.(event);

  res.statusCode = 204;
  res.end();
}

function handleStatus(res: ServerResponse, deps: HttpDeps): void {
  const now = deps.clock.now();
  const snapshot: StatusSnapshot = {
    state: deps.machine.globalState,
    pet: deps.petRef.slug,
    ts: now,
    sessions: deps.machine.snapshotSessions(),
    recentEvents: [...deps.recentEvents].slice(-10).reverse(),
    uptimeMs: now - deps.startedAt,
    wsClients: deps.broadcaster.clientCount(),
  };
  sendJson(res, 200, snapshot);
}

async function handleSwitch(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpDeps,
): Promise<void> {
  const body = await readJsonBody(req);
  if (typeof body !== "object" || body === null) {
    sendJson(res, 400, { error: "expected_object" });
    return;
  }
  const slug = (body as Record<string, unknown>).slug;
  if (typeof slug !== "string" || slug.length === 0) {
    sendJson(res, 400, { error: "invalid_slug" });
    return;
  }
  deps.petRef.slug = slug;
  deps.broadcaster.broadcastPet(slug);
  sendJson(res, 200, { ok: true, slug });
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function pushRecentEvent(buf: HookEvent[], e: HookEvent): void {
  buf.push(e);
  // Keep last 50; /status only surfaces 10 but a slightly bigger ring buffer
  // gives wiggle room for future debug endpoints.
  if (buf.length > 50) buf.splice(0, buf.length - 50);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload).toString(),
  });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown | undefined> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("body_too_large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve(undefined);
      }
    });
    req.on("error", reject);
  });
}
