import type {
  AutoResumeStatus,
  ClaudeAccountStatus,
  CodexAccountStatus,
  MachineStatus,
  AgentSessionContextUsage,
  SessionLastPromptState,
  StartupStatus,
} from "@agent-console/shared/api";
import type { ActivityTurnState } from "@agent-console/shared/activity";
import type { SessionTitleState } from "@agent-console/shared/title";
import type { SessionCoordinatorTree, SessionDispatchedBy } from "@agent-console/shared/api";
import type { SessionLineage, SessionRole } from "@agent-console/shared/lineage";
import type { SessionRetitlePath } from "@agent-console/shared/session-retitle";

export interface ProviderResume {
  readonly provider?: string;
  readonly session_id?: string;
  readonly resume_args?: readonly string[];
  readonly captured_at?: string;
  readonly capture_method?: string;
}

export type TurnState = ActivityTurnState;

export interface SessionLastPrompt {
  readonly text: string;
  readonly submitted_at?: string;
  readonly truncated?: boolean;
}

export interface Session {
  readonly id: string;
  readonly agent: string;
  readonly agent_profile?: string;
  readonly model?: string | null;
  readonly reasoning_effort?: string | null;
  /** Daemon context-window sample; absent on older agent-session versions. */
  readonly context_usage?: AgentSessionContextUsage | null;
  readonly mode?: string;
  readonly title?: string | null;
  readonly title_state?: SessionTitleState;
  /** Explicit daemon protocol capability; independent of whether this record already has state. */
  readonly title_state_supported?: boolean;
  /** Monotonic daemon-owned token for optimistic title updates; absent on old daemons. */
  readonly title_revision?: number;
  readonly title_mode?: "auto" | "pinned";
  readonly display_revision?: number;
  /** Random daemon runtime identity for delete/recreate and resume ABA protection. */
  readonly session_incarnation?: string;
  readonly cwd?: string;
  readonly status: string;
  readonly resumable?: boolean;
  /** Bounded daemon-owned reason code; present only when edge and daemon advertise the contract. */
  readonly resume_blocked_reason?: string;
  /** UI-derived from edge and per-machine daemon capabilities. */
  readonly managed_resume_command_available?: boolean;
  readonly repo_name?: string | null;
  readonly provider_resume?: ProviderResume | null;
  readonly attach_command?: string | null;
  readonly ssh_attach_command?: string | null;
  readonly created_at?: string;
  readonly updated_at?: string;
  readonly last_terminal_activity_at?: string;
  readonly runtime_started_at?: string;
  readonly turn_state?: TurnState | null;
  /** Absent for old daemons; null when a supplied projection failed validation. */
  readonly auto_resume?: AutoResumeStatus | null;
  /** Absent for old daemons; null when a supplied projection failed validation. */
  readonly startup?: StartupStatus | null;
  /** UI-derived from the edge-owned sessions capability; daemon fields cannot set it. */
  readonly auto_resume_control_available?: boolean;
  /**
   * Present only where the session's machine serves that provider's account
   * switch; null when a supplied projection failed validation.
   */
  readonly codex_account?: CodexAccountStatus | null;
  readonly claude_account?: ClaudeAccountStatus | null;
  /** Edge-added daemon observation anchor; absent for old daemons. */
  readonly activity_observed_at?: string;
  /** Most-recent user prompt preview from the edge (capability-gated); absent for old daemons/edge. */
  readonly last_prompt?: SessionLastPrompt;
  /** Newest user or assistant message; optional during daemon upgrades. */
  readonly last_message?: SessionLastPrompt & { readonly role: "user" | "assistant" };
  /** Exact producer freshness state; absent for old or incompatible daemon/edge pairs. */
  readonly last_prompt_state?: SessionLastPromptState;
  /** Opaque response-only fence that rotates when exact transcript continuity is lost. */
  readonly last_prompt_continuity?: string;
  readonly workspace?: string | null;
  readonly origin?: import("@agent-console/shared/api").SessionOrigin;
  /** Edge-recorded session that started this one through the coordination start route. */
  readonly dispatched_by?: SessionDispatchedBy;
  /** Edge-recorded depth in a coordinator's tree. */
  readonly coordinator_tree?: SessionCoordinatorTree;
  /** Daemon-recorded console role and lineage (session-lineage-work-v1). */
  readonly role?: SessionRole;
  readonly lineage?: SessionLineage;
  readonly lineage_adoption?: import("@agent-console/shared/lineage").SessionLineageAdoption;
  /** UI-owned rolling-upgrade selection; daemon v2 or the existing edge fallback. */
  readonly retitle_path?: SessionRetitlePath;
  readonly machine: string;
}

/** UI-only state that cannot collide with JSON fields supplied by a daemon. */
export const DASHBOARD_UNAVAILABLE_SINCE: unique symbol = Symbol("dashboard-unavailable-since");

export const DASHBOARD_ACTIVITY_OBSERVATION: unique symbol = Symbol("dashboard-activity-observation");

export interface DashboardActivityObservation {
  readonly daemonObservedAt: string;
  readonly receivedMonotonicMs: number;
  readonly transport: "poll" | "stream";
  readonly frozenSemanticNowMs?: number;
}

export type DashboardSession = Session & {
  readonly [DASHBOARD_UNAVAILABLE_SINCE]?: string;
  readonly [DASHBOARD_ACTIVITY_OBSERVATION]?: DashboardActivityObservation;
};

export interface SessionsResponse {
  readonly ext?: Readonly<Record<string, unknown>>;
  readonly ok: boolean;
  readonly sessions: Session[];
  readonly machines: MachineStatus[];
  // Set only when the request itself failed, so no machine is to blame.
  readonly error?: string;
  readonly capabilities?: Readonly<Record<string, unknown>> & {
    readonly auto_resume_control?: boolean;
    readonly profile_resume_import?: boolean;
    readonly managed_resume_command?: boolean;
    readonly resume_blocked_reason?: boolean;
    readonly last_prompt?: boolean;
    readonly last_message?: boolean;
    readonly history?: boolean;
    readonly archive?: boolean;
    readonly session_retitle_v2?: boolean;
    readonly session_retitle_v3?: boolean;
  };
}

export interface HistorySession {
  readonly id: string;
  readonly machine: string;
  readonly provider: "codex" | "claude";
  readonly provider_session_id: string;
  readonly agent_profile?: string;
  readonly title?: string | null;
  readonly prompt_preview?: string;
  readonly first_user_prompt_preview?: string;
  readonly last_user_prompt_preview?: string;
  readonly cwd: string;
  readonly repo_name?: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly archived_at?: string;
  readonly starred_at?: string;
  readonly resumable: boolean;
  readonly workspace?: string | null;
  readonly origin?: import("@agent-console/shared/api").SessionOrigin;
  /** The session that started this entry's live session, when the edge recorded one. */
  readonly dispatched_by?: SessionDispatchedBy;
  /** The live session's depth in a coordinator's tree, when the edge recorded one. */
  readonly coordinator_tree?: SessionCoordinatorTree;
}

export interface HistoryMessage {
  readonly images?: readonly import("@agent-console/shared/conversation-images").ConversationImage[];
  readonly id: string;
  readonly role: "user" | "assistant" | "goal" | "notice";
  readonly text: string;
  readonly timestamp?: string;
}

export interface HistorySessionsResponse {
  readonly ok: boolean;
  readonly sessions: HistorySession[];
  readonly nextCursor?: string;
  readonly truncated: boolean;
  readonly latestMessagePaging?: boolean;
  readonly starAvailable?: boolean;
  readonly resumeAvailable?: boolean;
  readonly error?: string;
}

export interface HistoryMessagesResponse {
  readonly ok: boolean;
  readonly messages: HistoryMessage[];
  readonly nextCursor?: string;
  readonly olderCursor?: string;
  readonly error?: string;
}

export interface Glance {
  readonly id: string;
  readonly agent: string;
  readonly title?: string | null;
  readonly title_state?: SessionTitleState;
  readonly title_state_supported?: boolean;
  readonly title_revision?: number;
  readonly status: string;
  readonly resumable?: boolean;
  readonly repo_name?: string | null;
  readonly provider_resume?: ProviderResume | null;
  readonly attach_command?: string | null;
  readonly ssh_attach_command?: string | null;
  readonly tail: string;
  readonly updated_at?: string;
  readonly last_terminal_activity_at?: string;
  readonly runtime_started_at?: string;
  readonly turn_state?: TurnState | null;
}

export interface CreateBody {
  readonly agent: string;
  readonly agent_profile?: string;
  readonly cwd?: string;
  readonly title?: string;
  readonly title_state?: SessionTitleState;
  readonly prompt?: string;
  readonly provider_resume_id?: string;
  readonly agent_args?: readonly string[];
  readonly codex_account?: string;
  readonly claude_account?: string;
}
