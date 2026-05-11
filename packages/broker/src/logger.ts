/**
 * Lightweight stderr logger.
 *
 * Constraint from spec: never write to stdout (would interfere with tools
 * piping JSON or curl output). All structured logs go to stderr; tests
 * silence by passing `enabled: false`.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

export interface LoggerOptions {
  enabled?: boolean;
  level?: LogLevel;
  /** Override sink for tests. */
  sink?: (line: string) => void;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function createLogger(opts: LoggerOptions = {}): Logger {
  const enabled = opts.enabled !== false;
  const level = opts.level ?? "info";
  const threshold = LEVEL_ORDER[level];
  const sink =
    opts.sink ??
    ((line: string) => {
      // Stderr only — never stdout.
      process.stderr.write(line + "\n");
    });

  function emit(lvl: LogLevel, msg: string, meta?: unknown): void {
    if (!enabled) return;
    if (LEVEL_ORDER[lvl] < threshold) return;
    const ts = new Date().toISOString();
    const base = `[${ts}] [${lvl}] ${msg}`;
    if (meta !== undefined) {
      try {
        sink(`${base} ${JSON.stringify(meta)}`);
      } catch {
        sink(base);
      }
    } else {
      sink(base);
    }
  }

  return {
    debug: (m, meta) => emit("debug", m, meta),
    info: (m, meta) => emit("info", m, meta),
    warn: (m, meta) => emit("warn", m, meta),
    error: (m, meta) => emit("error", m, meta),
  };
}

/** Logger that swallows all output. */
export const NullLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
