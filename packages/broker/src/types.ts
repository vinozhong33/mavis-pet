/**
 * Pet Broker — public type definitions.
 *
 * Consumed by:
 *   - State machine (per-session/global aggregation)
 *   - HTTP server (POST /event from mavis hooks)
 *   - WebSocket server (broadcast to floater clients)
 */

/**
 * Aggregated pet animation state, sorted by priority (highest wins).
 *
 * Priority order (top = wins):
 *   failed > review > jump > extra1 > extra2 > wave > run > idle
 *
 * Notes:
 *   - failed / wave / jump / extra1 / extra2 are TRANSIENT overlays that
 *     auto-degrade after a short TTL.
 *   - review is a STICKY overlay (no TTL) — set by PermissionRequested,
 *     cleared by PermissionResolved. Used to signal "agent is waiting on
 *     a user perm decision".
 *   - run is the per-session "base" state during a tool-using session.
 *   - idle is the default when no session is active and no overlay is set.
 */
export type PetState =
  | "failed"
  | "review"
  | "jump"
  | "extra1"
  | "extra2"
  | "run"
  | "wave"
  | "idle";

/** Hook event kinds we currently understand. */
export type HookEventKind =
  | "PreToolUse"
  | "PostToolUse"
  | "MessageComplete"
  | "UserPromptSubmit"
  | "SessionStart"
  | "SessionEnd"
  | "PermissionRequested"
  | "PermissionResolved";

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

/**
 * Outbound WebSocket message: state push.
 *
 * Optional `bubble` field carries a short speech-bubble string the floater
 * should render above the pet. `bubbleTtlMs` controls auto-dismiss
 * (defaults to 2500ms client-side if absent).
 */
export interface WsStateMessage {
  type: "state";
  state: PetState;
  ts: number;
  bubble?: string;
  bubbleTtlMs?: number;
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
