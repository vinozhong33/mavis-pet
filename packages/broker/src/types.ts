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
 * v0.4 task-card protocol — three optional UI hints, all backwards-compatible:
 *  - `title`     — bold one-line task title shown in the bubble card.
 *  - `subtitle`  — small two-line ellipsised description below the title.
 *  - `loading`   — when true, floater renders a spinner in the card's top-right.
 *
 * v0.4.2 — `activeSessionCount` drives the collapsed-state badge ("①") on
 * the floater. 0 = no badge, just the pet sprite alone (idle); >0 =
 * collapsed badge shows N. The floater also uses this to decide whether
 * to render the expanded card at all (count == 0 → no card, count > 0 →
 * card visible if user hasn't collapsed it).
 *
 * If `title` is set the floater renders the modern white rounded card; if only
 * `bubble` is set it falls back to the legacy compact pill (used for older
 * clients or simple one-liner notifications). `bubbleTtlMs` is shared by both
 * — defaults to 2500ms client-side; pass undefined for sticky (no auto-hide).
 */
export interface WsStateMessage {
  type: "state";
  state: PetState;
  ts: number;
  /** Legacy compact pill text (back-compat). Prefer `title` for new code. */
  bubble?: string;
  /** v0.4 task-card title (bold, one line, ellipsised). */
  title?: string;
  /** v0.4 task-card subtitle (light, two lines, ellipsised). */
  subtitle?: string;
  /** v0.4 — show spinner in card top-right (means "agent is working/waiting"). */
  loading?: boolean;
  /**
   * v0.4.2 — show **clock/hourglass icon** instead of spinner in card top-right.
   * Semantically distinct from `loading`:
   *   - `loading=true`   → spinner = "agent is actively running"
   *   - `waiting=true`   → clock   = "agent is BLOCKED waiting on user
   *                                   action (e.g. perm approval)"
   * Mutually exclusive at the UI level (waiting takes precedence over loading).
   */
  waiting?: boolean;
  /**
   * v0.4.3 — show **green check icon** in card top-right.
   * Semantically: "session finished, last assistant reply done streaming".
   * Replaces spinner/clock at the same position. Floater shows it for a
   * short transition window after session.finish before the card evicts.
   * Precedence: waiting > done > loading > none.
   */
  done?: boolean;
  /** Auto-dismiss ms; undefined = sticky until next state push. */
  bubbleTtlMs?: number;
  /** v0.4.2 — number of active mavis sessions; drives collapsed-state badge. */
  activeSessionCount?: number;
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
