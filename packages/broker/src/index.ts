/**
 * Public package surface.
 *
 * Consumers (CLI, tests, integration code) import from `@mavis-pet/broker`.
 * The CLI entry is `src/main.ts`.
 */

export { startBroker, DEFAULT_HOST, DEFAULT_PORT } from "./server.js";
export type { BrokerOptions, BrokerHandle } from "./server.js";
export { StateMachine } from "./state-machine.js";
export type {
  StateMachineOptions,
  StateChangeListener,
} from "./state-machine.js";
export { type Clock, type TimerHandle, RealClock, FakeClock } from "./clock.js";
export { createLogger, NullLogger } from "./logger.js";
export type { Logger, LoggerOptions, LogLevel } from "./logger.js";
export type {
  HookEvent,
  HookEventKind,
  PetState,
  SessionStatus,
  StatusSnapshot,
  WsOutMessage,
  WsStateMessage,
  WsPetMessage,
} from "./types.js";
