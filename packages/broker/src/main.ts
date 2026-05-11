/**
 * CLI entry — invoked by the `mavis-pet-broker` bin script.
 *
 * Reads config from CLI args + env, starts the broker, wires SIGINT/SIGTERM
 * for clean shutdown.
 *
 * ENV:
 *   MAVIS_PET_BROKER_HOST  default 127.0.0.1
 *   MAVIS_PET_BROKER_PORT  default 7857
 *   MAVIS_PET_DEFAULT_PET  default null
 *   MAVIS_PET_LOG_LEVEL    debug|info|warn|error  default info
 *
 * Args (override env):
 *   --host <addr>
 *   --port <port>
 *   --pet  <slug>
 *   --log-level <level>
 *   --quiet            shortcut for --log-level warn
 *   --help             print usage to stderr and exit 0
 */

import { createLogger, type LogLevel } from "./logger.js";
import { startBroker } from "./server.js";

interface CliArgs {
  host?: string;
  port?: number;
  pet?: string;
  logLevel?: LogLevel;
  help?: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--host":
        out.host = argv[++i];
        break;
      case "--port":
        out.port = Number(argv[++i]);
        break;
      case "--pet":
        out.pet = argv[++i];
        break;
      case "--log-level":
        out.logLevel = argv[++i] as LogLevel;
        break;
      case "--quiet":
        out.logLevel = "warn";
        break;
      case "--help":
      case "-h":
        out.help = true;
        break;
      default:
        // Ignore unknown flags so future CLI additions don't break old scripts.
        break;
    }
  }
  return out;
}

const USAGE = `mavis-pet-broker — Mavis Pet broker (HTTP + WebSocket)

Usage:
  mavis-pet-broker [--host 127.0.0.1] [--port 7857] [--pet <slug>] [--log-level info|debug|warn|error]

Endpoints:
  POST http://<host>:<port>/event       — receive mavis hook events
  GET  http://<host>:<port>/status      — broker snapshot
  POST http://<host>:<port>/switch      — switch active pet (body: {"slug":"boba"})
  WS   ws://<host>:<port>/ws            — floater pushes (state + pet messages)

ENV:
  MAVIS_PET_BROKER_HOST   override host
  MAVIS_PET_BROKER_PORT   override port
  MAVIS_PET_DEFAULT_PET   default active pet slug
  MAVIS_PET_LOG_LEVEL     debug|info|warn|error
`;

export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.help) {
    process.stderr.write(USAGE);
    process.exit(0);
  }

  const host =
    args.host ??
    process.env.MAVIS_PET_BROKER_HOST ??
    "127.0.0.1";
  const portStr = process.env.MAVIS_PET_BROKER_PORT;
  const port =
    args.port ?? (portStr ? Number(portStr) : 7857);
  if (!Number.isFinite(port) || port < 0 || port > 65_535) {
    process.stderr.write(`error: invalid port: ${port}\n`);
    process.exit(2);
  }

  const pet = args.pet ?? process.env.MAVIS_PET_DEFAULT_PET ?? null;
  const logLevel: LogLevel =
    args.logLevel ??
    ((process.env.MAVIS_PET_LOG_LEVEL as LogLevel | undefined) ?? "info");

  const logger = createLogger({ level: logLevel });

  let handle;
  try {
    handle = await startBroker({ host, port, pet, logger });
  } catch (err) {
    process.stderr.write(
      `error: failed to start broker on ${host}:${port}: ${(err as Error).message}\n`,
    );
    process.exit(1);
  }

  // Print resolved bind line to stderr so callers can scrape it without
  // polluting stdout (constraint: stdout must remain clean).
  process.stderr.write(
    `mavis-pet-broker listening on http://${handle.host}:${handle.port} (ws path: /ws)\n`,
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`mavis-pet-broker received ${signal}, shutting down\n`);
    try {
      await handle.close();
    } catch (err) {
      process.stderr.write(`shutdown error: ${(err as Error).message}\n`);
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

// Top-level execution gate: only run if invoked directly (not when imported).
const invokedDirectly =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /(?:^|\/)main(?:\.[mc]?js|\.ts)?$/.test(process.argv[1]);

if (invokedDirectly) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`fatal: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
