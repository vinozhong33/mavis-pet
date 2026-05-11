/**
 * Pet Broker — public type definitions.
 *
 * These are the contracts consumed by:
 *   - State machine (per-session/global aggregation)
 *   - HTTP server (POST /event from mavis hooks)
 *   - WebSocket server (broadcast to floater clients)
 */

/** Aggregated pet animation state, sorted by priority (highest wins). */
export type PetState = "failed" | "run" | "wave" | "idle";

/** Hook event kinds we currently understand. */
export type HookEventKind = "PreToolUse" | "PostToolUse" | "MessageComplete";

/** Inbound HTTP event payload (`POST /event`). */
export interface HookEvent {
  kind: HookEventKind;
  sessionId: string;
  /** Optional tool name (for PreToolUse / PostToolUse). */
  tool?: string;
  /** Optional exit code (for PostToolUse — non-zero means failure). */
  exitCode?: number;
  /** Optional caller-provided millisecond timestamp; falls back to clock.now(). */
  ts?: number;
}

/** Per-session derived status, used internally and surfaced via GET /status. */
export interface SessionStatus {
  sessionId: string;
  /** Currently effective per-session state. */
  state: PetState;
  /** Last event timestamp (ms) for this session. */
  lastEventTs: number;
  /** Last event kind for this session. */
  lastEventKind?: HookEventKind;
}

/** Outbound WebSocket message: state push. */
export interface WsStateMessage {
  type: "state";
  state: PetState;
  ts: number;
}

/** Outbound WebSocket message: pet (slug) switch. */
export interface WsPetMessage {
  type: "pet";
  slug: string;
}

export type WsOutMessage = WsStateMessage | WsPetMessage;

/** Snapshot returned by GET /status. */
export interface StatusSnapshot {
  state: PetState;
  pet: string | null;
  ts: number;
  sessions: SessionStatus[];
  /** Most-recent N events, newest first. */
  recentEvents: HookEvent[];
  uptimeMs: number;
  wsClients: number;
}
