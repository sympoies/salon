import { parseSessionNotice } from "./parseSessionNotice.ts";
import { unwrapPastedContent } from "./pastedContent.ts";
import { normalizeSessionModelSettings } from "./sessionModel.ts";
import { normalizeActivityTurnState } from "./activity.ts";
import {
  normalizeSessionLineage,
  normalizeSessionLineageAdoption,
  normalizeSessionRole,
  normalizeSessionWork,
} from "./lineage.ts";
import { normalizeSessionTitleState, type SessionTitleState } from "./title.ts";
import type { SessionRetitleV3Receipts } from "./sessionRetitle.ts";

export type TitleSummarySource = "summarizer" | "fallback";

export const AGENT_CONSOLE_PERMISSIONS = [
  "debug",
  "usage",
  "codex_reset",
  "provider_import",
  "terminal",
] as const;
export type AgentConsolePermission = (typeof AGENT_CONSOLE_PERMISSIONS)[number];

export interface AgentConsolePrincipal {
  readonly id: string;
  readonly permissions: readonly string[];
  readonly defaultVisibleMachines?: readonly string[];
  readonly defaultCreateMachine?: string;
}

const CLIENT_PERMISSION = /^[a-z][a-z0-9_]{0,63}$/;

export function normalizeAgentConsolePrincipal(value: unknown): AgentConsolePrincipal | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.id !== "string"
    || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(raw.id)
    || !Array.isArray(raw.permissions)
  ) return null;
  const permissions: string[] = [];
  const seen = new Set<string>();
  for (const permission of raw.permissions) {
    if (
      typeof permission !== "string"
      || !CLIENT_PERMISSION.test(permission)
      || seen.has(permission)
    ) return null;
    seen.add(permission);
    permissions.push(permission);
  }
  const defaultVisibleMachines = raw.defaultVisibleMachines;
  if (defaultVisibleMachines !== undefined && (
    !Array.isArray(defaultVisibleMachines)
    || !defaultVisibleMachines.every((machine) => typeof machine === "string" && machine.length > 0)
    || new Set(defaultVisibleMachines).size !== defaultVisibleMachines.length
  )) return null;
  const defaultCreateMachine = raw.defaultCreateMachine;
  if (defaultCreateMachine !== undefined && (typeof defaultCreateMachine !== "string" || defaultCreateMachine.length === 0)) return null;
  return {
    id: raw.id,
    permissions,
    ...(defaultVisibleMachines === undefined ? {} : { defaultVisibleMachines }),
    ...(defaultCreateMachine === undefined ? {} : { defaultCreateMachine }),
  };
}

export const TITLE_SUMMARY_PHASES = ["initial", "turn", "completion", "manual"] as const;
export type TitleSummaryPhase = (typeof TITLE_SUMMARY_PHASES)[number];

export const TITLE_SUMMARY_DIAGNOSTIC_REASONS = [
  "accepted",
  "fallback_not_configured",
  "fallback_unsafe_prompt",
  "fallback_busy",
  "fallback_timeout",
  "fallback_command_error",
  "fallback_invalid_output",
  "fallback_unsafe_activity",
  "fallback_invalid_topic",
  "fallback_unapproved_reference",
  "fallback_unknown",
] as const;
export type TitleSummaryDiagnosticReason = (typeof TITLE_SUMMARY_DIAGNOSTIC_REASONS)[number];

export interface TitleSummaryTrace {
  readonly attemptId: string;
  readonly machine: string;
  readonly sessionId: string;
  readonly phase: TitleSummaryPhase;
  readonly attempt: number;
}

export interface TitleSummaryRequest {
  readonly baseTitle?: string | null;
  readonly titleState?: SessionTitleState | null;
  readonly prompt: string;
  readonly currentTitle?: string | null;
  readonly recentOutput?: string | null;
  readonly agent?: string | null;
  readonly repoName?: string | null;
  /** Content-free correlation metadata. The edge never forwards this to the model. */
  readonly trace?: TitleSummaryTrace;
}

export interface TitleSummaryResult {
  readonly title: string | null;
  readonly titleState?: SessionTitleState;
  readonly source: TitleSummarySource;
  readonly diagnosticReason?: TitleSummaryDiagnosticReason;
}

export interface MachineStatus {
  readonly name: string;
  readonly ok: boolean;
  readonly active?: boolean;
  readonly error?: string;
  readonly observed_at?: string;
  readonly capabilities?: AgentSessionCapabilities;
  readonly agent_profiles?: readonly AgentLaunchProfileSummary[];
}

export interface AgentSessionContextUsage {
  readonly used_tokens: number | null;
  readonly window_tokens: number | null;
  readonly source: "claude-transcript" | "codex-rollout" | null;
  readonly observed_at: string | null;
  readonly model: string | null;
}

/** Validate the daemon-owned context usage snapshot before exposing it publicly. */
export function normalizeAgentSessionContextUsage(value: unknown): AgentSessionContextUsage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!["used_tokens", "window_tokens", "source", "observed_at", "model"].every((field) => Object.hasOwn(raw, field))) return null;
  if (raw.used_tokens !== null && (!Number.isSafeInteger(raw.used_tokens) || Number(raw.used_tokens) < 0)) return null;
  if (raw.window_tokens !== null && (!Number.isSafeInteger(raw.window_tokens) || Number(raw.window_tokens) <= 0)) return null;
  if (raw.source !== null && raw.source !== "claude-transcript" && raw.source !== "codex-rollout") return null;
  const observedAt = raw.observed_at;
  if (observedAt !== null && (
    typeof observedAt !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(observedAt)
    || !Number.isFinite(Date.parse(observedAt))
  )) return null;
  if (raw.model !== null && typeof raw.model !== "string") return null;
  const model = raw.model === null ? null : normalizeSessionModelSettings({ model: raw.model }).model;
  return {
    used_tokens: raw.used_tokens as number | null,
    window_tokens: raw.window_tokens as number | null,
    source: raw.source as AgentSessionContextUsage["source"],
    observed_at: observedAt as string | null,
    model,
  };
}

export interface MachinePreferenceChange {
  readonly actor: string;
  readonly reason: string;
  readonly at: string;
  readonly revision: number;
}
export interface MachinePreference {
  readonly name: string;
  readonly enabled: boolean;
  readonly active: boolean;
  readonly last_change: MachinePreferenceChange | null;
}

export const ACCOUNT_PROVIDERS = ["codex", "claude"] as const;
export type AccountProvider = (typeof ACCOUNT_PROVIDERS)[number];

export const ACCOUNT_PROVIDER_LABELS: Readonly<Record<AccountProvider, string>> = {
  codex: "Codex",
  claude: "Claude",
};

export function isAccountProvider(value: unknown): value is AccountProvider {
  return (ACCOUNT_PROVIDERS as readonly unknown[]).includes(value);
}

export interface AgentSessionCapabilities {
  readonly profile_resume_import?: boolean;
  readonly managed_resume_command?: boolean;
  readonly resume_blocked_reason?: boolean;
  readonly last_prompt?: boolean;
  readonly last_message?: boolean;
  readonly history?: boolean;
  readonly archive?: boolean;
  readonly history_star?: boolean;
  readonly session_retitle_v2?: boolean;
  readonly session_retitle_v3?: boolean;
  /** The daemon binds Codex sessions to broker accounts (serve API `codex_account`). */
  readonly codex_account_switch?: boolean;
  /** The daemon binds Claude sessions to broker accounts (serve API `claude_account`). */
  readonly claude_account_switch?: boolean;
}

// Daemons that predate the Codex flag always serve the Codex switch, so only an
// explicit `false` turns it off; the Claude switch must be advertised.
const ACCOUNT_SWITCH_WITHOUT_FLAG: Readonly<Record<AccountProvider, boolean>> = {
  codex: true,
  claude: false,
};

export function machineServesAccountSwitch(
  provider: AccountProvider,
  capabilities: AgentSessionCapabilities | undefined,
): boolean {
  return capabilities?.[`${provider}_account_switch`] ?? ACCOUNT_SWITCH_WITHOUT_FLAG[provider];
}

export interface AgentLaunchProfileSummary {
  readonly id: string;
  readonly label: string;
  readonly agent: "codex" | "claude";
  readonly provider_resume_import_supported?: boolean;
}

export const MAX_AGENT_LAUNCH_PROFILES = 16;
export const MAX_AGENT_LAUNCH_PROFILE_ID_LENGTH = 32;

const SAFE_RESUME_BLOCKED_REASONS = new Set([
  "agent-profile-unavailable",
  "agent-profile-metadata-unavailable",
  "agent-profile-context-mismatch",
]);

export function normalizeAgentLaunchProfileId(value: unknown): string | undefined {
  return typeof value === "string"
    && value.length <= MAX_AGENT_LAUNCH_PROFILE_ID_LENGTH
    && /^[a-z0-9][a-z0-9-]*$/.test(value)
    ? value
    : undefined;
}

export function normalizeAgentSessionCapabilities(value: unknown): AgentSessionCapabilities {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  return {
    ...(raw.profile_resume_import === true ? { profile_resume_import: true } : {}),
    ...(raw.managed_resume_command === true ? { managed_resume_command: true } : {}),
    ...(raw.resume_blocked_reason === true ? { resume_blocked_reason: true } : {}),
    ...(raw.last_prompt === true ? { last_prompt: true } : {}),
    ...(raw.last_message === true ? { last_message: true } : {}),
    ...(raw.history === true ? { history: true } : {}),
    ...(raw.archive === true ? { archive: true } : {}),
    ...(raw.history_star === true ? { history_star: true } : {}),
    ...(raw.session_retitle_v2 === true ? { session_retitle_v2: true } : {}),
    ...(raw.session_retitle_v3 === true ? { session_retitle_v3: true } : {}),
    ...(typeof raw.codex_account_switch === "boolean" ? { codex_account_switch: raw.codex_account_switch } : {}),
    ...(typeof raw.claude_account_switch === "boolean" ? { claude_account_switch: raw.claude_account_switch } : {}),
  };
}

export function normalizeAgentLaunchProfiles(value: unknown): AgentLaunchProfileSummary[] {
  if (!Array.isArray(value)) return [];
  const profiles: AgentLaunchProfileSummary[] = [];
  const seen = new Set<string>();
  for (const entry of value.slice(0, MAX_AGENT_LAUNCH_PROFILES)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const raw = entry as Record<string, unknown>;
    const id = normalizeAgentLaunchProfileId(raw.id);
    const label = typeof raw.label === "string" ? raw.label.trim() : "";
    const agent = raw.agent;
    if (
      id === undefined
      || seen.has(id)
      || label.length === 0
      || label.length > 64
      || /[\u0000-\u001f\u007f]/.test(label)
      || (agent !== "codex" && agent !== "claude")
    ) continue;
    seen.add(id);
    profiles.push({
      id,
      label,
      agent,
      ...(raw.provider_resume_import_supported === true
        ? { provider_resume_import_supported: true }
        : {}),
    });
  }
  return profiles;
}

export function normalizeResumeBlockedReason(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_RESUME_BLOCKED_REASONS.has(value) ? value : undefined;
}

const MAX_PUBLIC_SESSION_STRING = 4_096;
const MAX_PROVIDER_RESUME_ARGS = 64;

function publicSessionString(value: unknown, maxLength = MAX_PUBLIC_SESSION_STRING): string | undefined {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : undefined;
}

const MAX_PUBLIC_LAST_PROMPT = 2_048;
const LAST_PROMPT_CONTINUITY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
export type SessionLastPromptState = "current" | "pending" | "unavailable";

function normalizeLastPromptState(value: unknown): SessionLastPromptState | undefined {
  return value === "current" || value === "pending" || value === "unavailable"
    ? value
    : undefined;
}

export function normalizeLastPromptContinuity(value: unknown): string | undefined {
  return typeof value === "string" && LAST_PROMPT_CONTINUITY_PATTERN.test(value)
    ? value
    : undefined;
}

/**
 * Client harness constructs that can end up inside a captured prompt: a shell
 * escape the client echoed back, a slash-command header, an injected reminder.
 * They describe how the text reached the terminal, not what the user asked
 * for, so a card preview built from them is noise.
 */
const HARNESS_WRAPPER_TAGS = [
  "bash-input",
  "bash-stdout",
  "bash-stderr",
  "command-name",
  "command-message",
  "command-args",
  "local-command-stdout",
  "local-command-stderr",
  "system-reminder",
  "task-notification",
] as const;

/**
 * Matches a whole wrapper block. The `|$` arm matters: the capture is length
 * capped upstream, so a wrapper frequently arrives with its closing tag cut
 * off — everything from the opening tag onward is still scaffolding. Only these
 * exact names are stripped, so markup the user genuinely wrote about (`<div>`)
 * survives untouched.
 */
const HARNESS_WRAPPER_PATTERN = new RegExp(
  `<(${HARNESS_WRAPPER_TAGS.join("|")})>[\\s\\S]*?(?:</\\1>|$)`,
  "g",
);

/**
 * Public projection of the daemon `last_prompt` preview. Harness wrapper blocks
 * are dropped. Strict v1 notices use a marked first body line; other text is
 * flattened to a single line (newlines/tabs collapse to spaces) for a one-line card preview, control chars rejected,
 * unknown members dropped, and text length re-capped. Returns `undefined` for
 * anything empty or malformed — including a prompt that was nothing but
 * scaffolding — so the field is simply omitted.
 */
function normalizePublicLastPrompt(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.text !== "string") return undefined;
  const prompt = unwrapPastedContent(raw.text);
  const notice = parseSessionNotice(prompt);
  const body = notice ? notice.body.split(/\r?\n/, 1)[0]! : prompt;
  const cleaned = body.replace(HARNESS_WRAPPER_PATTERN, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length === 0 || /\p{Cc}/u.test(cleaned)) return undefined;
  const text = notice ? `Notice: ${cleaned}` : cleaned;
  const submittedAt = publicSessionString(raw.submitted_at, 64);
  return {
    text: text.length > MAX_PUBLIC_LAST_PROMPT ? text.slice(0, MAX_PUBLIC_LAST_PROMPT) : text,
    ...(typeof raw.truncated === "boolean" ? { truncated: raw.truncated } : {}),
    ...(submittedAt ? { submitted_at: submittedAt } : {}),
  };
}

function normalizePublicProviderResume(value: unknown): Record<string, unknown> | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const provider = publicSessionString(raw.provider, 64);
  const sessionId = publicSessionString(raw.session_id);
  const capturedAt = publicSessionString(raw.captured_at, 64);
  const captureMethod = publicSessionString(raw.capture_method, 64);
  const resumeArgs = Array.isArray(raw.resume_args)
    && raw.resume_args.length <= MAX_PROVIDER_RESUME_ARGS
    && raw.resume_args.every((item) => publicSessionString(item) !== undefined)
    ? raw.resume_args as string[]
    : undefined;
  return {
    ...(provider ? { provider } : {}),
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(resumeArgs ? { resume_args: [...resumeArgs] } : {}),
    ...(capturedAt ? { captured_at: capturedAt } : {}),
    ...(captureMethod ? { capture_method: captureMethod } : {}),
  };
}

/** Additive workspace metadata from agent-session; old servers omit both fields. */
export interface SessionOrigin {
  readonly parent: { readonly session_id: string; readonly machine: string } | null;
}
export function normalizeSessionWorkspace(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64 || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(value)) return null;
  if (/^(?:sk-|glpat-|pypi-|xoxb-|xoxp-)/.test(value) || (/^(?:akia|aiza)/.test(value) && value.length >= 20)) return null;
  return value;
}
export function normalizeSessionOrigin(value: unknown): SessionOrigin | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const parent = (value as Record<string, unknown>).parent;
  if (parent === null) return { parent: null };
  if (!parent || typeof parent !== "object" || Array.isArray(parent)) return undefined;
  const raw = parent as Record<string, unknown>;
  const session_id = publicSessionString(raw.session_id, 512);
  const machine = publicSessionString(raw.machine, 128);
  return session_id && machine ? { parent: { session_id, machine } } : undefined;
}

/** Public launch-switch shape only; the target daemon owns allowlist admission. */
export function normalizeSessionLaunchEnv(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length > 16) return undefined;
  for (const [key, item] of entries) {
    if (key.length > 128 || !/^AGENT_RUNTIME_[A-Z0-9_]+$/.test(key)
      || /SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|API_KEY|PRIVATE_KEY/.test(key)
      || typeof item !== "string" || new TextEncoder().encode(item).length > 1024
      || /\p{Cc}/u.test(item)) return undefined;
  }
  return Object.fromEntries(entries);
}

/**
 * Explicit public projection for daemon session records. Unknown fields and
 * unknown nested members are dropped so schema drift cannot expose host-only
 * launcher, provider-root, readiness, or environment details.
 */
export function projectPublicAgentSession(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (Object.hasOwn(raw, "workspace")) out.workspace = normalizeSessionWorkspace(raw.workspace);
  const origin = normalizeSessionOrigin(raw.origin);
  if (origin) out.origin = origin;
  const launchEnv = normalizeSessionLaunchEnv(raw.launch_env);
  if (launchEnv !== undefined) out.launch_env = launchEnv;

  for (const [field, maxLength] of [
    ["id", 512],
    ["agent", 64],
    ["mode", 64],
    ["cwd", MAX_PUBLIC_SESSION_STRING],
    ["tmux_session", 512],
    ["status", 64],
    ["attach_command", MAX_PUBLIC_SESSION_STRING],
    ["created_at", 64],
    ["updated_at", 64],
    ["last_terminal_activity_at", 64],
    ["runtime_started_at", 64],
    ["session_incarnation", 512],
  ] as const) {
    const normalized = publicSessionString(raw[field], maxLength);
    if (normalized !== undefined) out[field] = normalized;
  }

  for (const field of ["title", "repo_name", "ssh_attach_command"] as const) {
    if (raw[field] === null) {
      out[field] = null;
      continue;
    }
    const normalized = publicSessionString(raw[field], field === "title" ? 512 : MAX_PUBLIC_SESSION_STRING);
    if (normalized !== undefined) out[field] = normalized;
  }

  for (const field of ["resumable", "title_state_supported"] as const) {
    if (typeof raw[field] === "boolean") out[field] = raw[field];
  }
  if (raw.title_mode === "auto" || raw.title_mode === "pinned") out.title_mode = raw.title_mode;
  if (Number.isSafeInteger(raw.display_revision) && Number(raw.display_revision) >= 0) out.display_revision = Number(raw.display_revision);
  if (Number.isSafeInteger(raw.title_revision) && Number(raw.title_revision) >= 0) {
    out.title_revision = Number(raw.title_revision);
  }

  if (Object.hasOwn(raw, "model") || Object.hasOwn(raw, "reasoning_effort")) {
    Object.assign(out, normalizeSessionModelSettings(raw));
  }
  if (Object.hasOwn(raw, "context_usage")) {
    out.context_usage = normalizeAgentSessionContextUsage(raw.context_usage);
  }
  const agentProfile = normalizeAgentLaunchProfileId(raw.agent_profile);
  if (agentProfile !== undefined) out.agent_profile = agentProfile;
  const blockedReason = normalizeResumeBlockedReason(raw.resume_blocked_reason);
  if (blockedReason !== undefined) out.resume_blocked_reason = blockedReason;
  const titleState = normalizeSessionTitleState(raw.title_state);
  if (titleState) out.title_state = titleState;

  if (Object.hasOwn(raw, "provider_resume")) {
    out.provider_resume = normalizePublicProviderResume(raw.provider_resume);
  }
  if (Object.hasOwn(raw, "turn_state")) {
    out.turn_state = raw.turn_state === null ? null : normalizeActivityTurnState(raw.turn_state);
  }
  const hasLastPromptState = Object.hasOwn(raw, "last_prompt_state");
  const lastPromptState = hasLastPromptState
    ? normalizeLastPromptState(raw.last_prompt_state)
    : undefined;
  if (
    Object.hasOwn(raw, "last_prompt")
    && (!hasLastPromptState || lastPromptState === "current")
  ) {
    const lastPrompt = normalizePublicLastPrompt(raw.last_prompt);
    if (lastPrompt) out.last_prompt = lastPrompt;
  }
  const message = raw.last_message;
  if (message && typeof message === "object" && !Array.isArray(message)) {
    const role = (message as Record<string, unknown>).role;
    const preview = normalizePublicLastPrompt(message);
    if (preview && (role === "user" || role === "assistant")) {
      out.last_message = { role, ...preview };
    }
  }
  if (lastPromptState) out.last_prompt_state = lastPromptState;
  const lastPromptContinuity = lastPromptState
    ? normalizeLastPromptContinuity(raw.last_prompt_continuity)
    : undefined;
  if (lastPromptContinuity) {
    out.last_prompt_continuity = lastPromptContinuity;
  }
  if (Object.hasOwn(raw, "auto_resume")) {
    out.auto_resume = normalizeAutoResumeStatus(raw.auto_resume);
  }
  if (Object.hasOwn(raw, "codex_account")) {
    out.codex_account = normalizeCodexAccountStatus(raw.codex_account);
  }
  if (Object.hasOwn(raw, "claude_account")) {
    out.claude_account = normalizeClaudeAccountStatus(raw.claude_account);
  }
  if (Object.hasOwn(raw, "startup")) {
    out.startup = normalizeStartupStatus(raw.startup);
  }
  // session-lineage-work-v1: `null` means none was recorded; a malformed
  // value is dropped.
  const lineage = normalizeSessionLineage(raw.lineage);
  if (lineage) out.lineage = lineage;
  if (raw.work === null) out.work = null;
  else {
    const work = normalizeSessionWork(raw.work);
    if (work) out.work = work;
  }
  const adoption = normalizeSessionLineageAdoption(raw.lineage_adoption);
  if (adoption) out.lineage_adoption = adoption;
  const role = normalizeSessionRole(raw.role);
  if (role) out.role = role;
  return out;
}

/** Facts a refresh re-reads from live session state. Account is never among them. */
const SESSION_REFRESH_FACTS = ["model", "reasoning_effort", "title"] as const;
const SESSION_REFRESH_UNAVAILABLE = ["model", "reasoning_effort", "account"] as const;

export interface SessionRefresh {
  readonly session_id: string;
  /** Facts whose stored value changed. */
  readonly changed: readonly (typeof SESSION_REFRESH_FACTS)[number][];
  /** Facts the host could not re-read; account is always reported here. */
  readonly unavailable: readonly (typeof SESSION_REFRESH_UNAVAILABLE)[number][];
  readonly session: Record<string, unknown>;
}

function knownTokens<T extends string>(value: unknown, known: readonly T[]): T[] | null {
  if (!Array.isArray(value) || value.length > 16) return null;
  return known.filter((token) => value.includes(token));
}

/** Strict public projection of one refreshed session; unknown future tokens are dropped. */
export function normalizeSessionRefresh(value: unknown, expectedId: string): SessionRefresh | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const changed = knownTokens(raw.changed, SESSION_REFRESH_FACTS);
  const unavailable = knownTokens(raw.unavailable, SESSION_REFRESH_UNAVAILABLE);
  const session = projectPublicAgentSession(raw.session);
  if (raw.session_id !== expectedId || !changed || !unavailable
    || session.id !== expectedId || typeof session.agent !== "string") return null;
  return { session_id: expectedId, changed, unavailable, session };
}

export interface PublicSessionDeleteResult {
  readonly id: string;
  readonly deleted: true;
  readonly killed: boolean;
  readonly cleanup_pending: boolean;
}

/** Strict public acknowledgement for the logical-delete boundary. */
export function normalizePublicSessionDeleteResult(
  value: unknown,
  expectedId?: string,
): PublicSessionDeleteResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = publicSessionString(raw.id, 512);
  if (!id || (expectedId !== undefined && id !== expectedId) || raw.deleted !== true) return null;
  if (raw.killed !== undefined && typeof raw.killed !== "boolean") return null;
  if (raw.cleanup_pending !== undefined && typeof raw.cleanup_pending !== "boolean") return null;
  return {
    id,
    deleted: true,
    killed: raw.killed === true,
    cleanup_pending: raw.cleanup_pending === true,
  };
}

/**
 * The session that started this one through the coordination start route
 * (`POST /api/coordination/sessions/v1`); a root start whose lineage names no
 * parent (`--no-parent`) has none. The edge adds it to the session list
 * and board records from its access store; it is display-only and never an
 * authorization input. `repo_name` is the dispatcher's repository when it
 * started the session, so the mark outlives the dispatcher.
 */
export interface SessionDispatchedBy {
  readonly machine: string;
  readonly session_id: string;
  readonly repo_name?: string;
}

/**
 * The session's depth in a coordinator's tree (the coordinator and the sessions started
 * inside its dispatch tree): 0 for a coordinator, 1 for a session it started,
 * and so on. The edge records it when the session starts, so it never changes
 * after an ancestor closes. Absent outside every coordinator's tree.
 * Display-only and never an authorization input.
 */
export interface SessionCoordinatorTree {
  readonly depth: number;
}

const MAX_COORDINATOR_TREE_DEPTH = 64;

export function normalizeSessionCoordinatorTree(value: unknown): SessionCoordinatorTree | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const depth = (value as Record<string, unknown>).depth;
  return Number.isSafeInteger(depth) && (depth as number) >= 0 && (depth as number) <= MAX_COORDINATOR_TREE_DEPTH
    ? { depth: depth as number }
    : undefined;
}

/** Strict projection of `dispatched_by`; anything malformed is dropped. */
export function normalizeSessionDispatchedBy(value: unknown): SessionDispatchedBy | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const machine = publicSessionString(raw.machine, 512);
  const sessionId = publicSessionString(raw.session_id, 512);
  if (!machine || !sessionId) return undefined;
  const repoName = publicSessionString(raw.repo_name, 256);
  return { machine, session_id: sessionId, ...(repoName ? { repo_name: repoName } : {}) };
}

export interface LayoutDocument {
  readonly order: string[];
  readonly revision: number | null;
}

export interface LayoutWriteRequest {
  readonly order: readonly string[];
  readonly baseRevision?: number | null;
  readonly reason?: string;
}

export interface LayoutWriteResult extends LayoutDocument {
  readonly conflict: boolean;
  readonly error?: string;
}

export const MAX_ORDER_ENTRIES = 256;
const MAX_ORDER_KEY_LENGTH = 512;

export function normalizeOrder(body: unknown): string[] {
  const raw = Array.isArray(body)
    ? body
    : body && typeof body === "object" && Array.isArray((body as { order?: unknown }).order)
      ? (body as { order: unknown[] }).order
      : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry.length > MAX_ORDER_KEY_LENGTH ||
      seen.has(entry)
    ) {
      continue;
    }
    seen.add(entry);
    out.push(entry);
    if (out.length >= MAX_ORDER_ENTRIES) {
      break;
    }
  }
  return out;
}

export function normalizeRevision(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function normalizeLayoutDocument(body: unknown): LayoutDocument {
  return {
    order: normalizeOrder(body),
    revision: body && typeof body === "object" ? normalizeRevision((body as { revision?: unknown }).revision) : null,
  };
}

export interface Reachable {
  readonly reachable: boolean;
  readonly error?: string;
}

export interface UsageWindow {
  readonly key: string;
  readonly label: string;
  readonly used_percent: number | null;
  readonly window_minutes: number | null;
  readonly resets_at: number | null;
}

export type ProviderUsageReason =
  | "auth_required"
  | "auth_expired"
  | "billing_past_due"
  | "subscription_inactive"
  | "organization_disabled"
  | "permission_denied"
  | "rate_limited"
  | "service_unavailable"
  | "timeout"
  | "unknown";

export interface ProviderUsage {
  readonly provider: string;
  // Account display label when a provider reports more than one account: a
  // Codex nickname (one entry per configured account), or the signed-in Claude
  // account's email on per-host Claude entries; null otherwise. Entries are keyed
  // by (provider, account, hosts). Never a credential.
  readonly account: string | null;
  readonly label: string;
  readonly ok: boolean;
  readonly stale: boolean;
  readonly plan: string | null;
  readonly windows: readonly UsageWindow[];
  readonly updated_at: number | null;
  readonly note: string | null;
  readonly error: string | null;
  readonly reason_code: ProviderUsageReason | null;
  readonly reset_credits: { readonly available_count: number } | null;
  // Claude limit-reset status for a Claude account entry, as read on the host
  // that owns the account's sign-in. Absent or null means unknown (an older
  // reader, or a missing/malformed upstream block); never a credential or id.
  readonly limit_resets?: ClaudeLimitResets | null;
  // Machine names signed in to this entry's account, as reported by the usage
  // reader for per-host Claude entries and scoped by the edge to the principal's
  // machines; absent for entries that are not per host.
  readonly hosts?: readonly string[];
  readonly ext?: Readonly<Record<string, unknown>>;
  // The name that makes this entry's account the provider default, set by the
  // edge for every provider: the Codex nickname or the Claude profile. Absent
  // when the entry names no switchable account.
  readonly switch_key?: string;
}

export const CODEX_RATE_LIMIT_RESET_SCHEMA_VERSION = "agent-console.codex-rate-limit-reset.v1";

export type CodexRateLimitResetOutcome =
  | "reset"
  | "nothing_to_reset"
  | "no_credit"
  | "already_redeemed";

export interface CodexRateLimitResetResult {
  readonly schema_version: typeof CODEX_RATE_LIMIT_RESET_SCHEMA_VERSION;
  readonly outcome: CodexRateLimitResetOutcome;
  readonly windows_reset?: number;
}

// Claude's two limit-reset programs (undocumented upstream; Claude Code uses
// both): `juniper_tide` resets the 5-hour session limit once a week at the wall
// and still counts toward the weekly limit; `cedar_ember` redeems an occasional
// granted reset, each grant with its own expiry.
export const CLAUDE_LIMIT_RESET_PROGRAMS = ["juniper_tide", "cedar_ember"] as const;
export type ClaudeLimitResetProgram = (typeof CLAUDE_LIMIT_RESET_PROGRAMS)[number];

export interface ClaudeSessionReset {
  readonly available: boolean;
  // Upstream token such as `not_at_wall`, `tenure`, or `surface`; null when available.
  readonly ineligible_reason: string | null;
  readonly resets_per_week: number | null;
  readonly next_available_at: number | null;
  readonly weekly_resets_at: number | null;
}

export interface ClaudeResetGrant {
  readonly label: string | null;
  readonly resets_left: number;
  readonly resets_total: number | null;
  readonly starts_at: number | null;
  readonly expires_at: number | null;
  // Limit names a redemption clears, e.g. `five_hour` or `seven_day`.
  readonly clears: readonly string[];
  readonly usable_now: boolean;
}

export interface ClaudeGrantedResets {
  readonly available: boolean;
  readonly ineligible_reason: string | null;
  readonly grants: readonly ClaudeResetGrant[];
  readonly cooldown_until: number | null;
  readonly weekly_resets_at: number | null;
}

// Each program is null when its status is unknown.
export interface ClaudeLimitResets {
  readonly juniper_tide: ClaudeSessionReset | null;
  readonly cedar_ember: ClaudeGrantedResets | null;
}

export const CLAUDE_LIMIT_RESET_SCHEMA_VERSION = "agent-console.claude-limit-reset.v1";

export const CLAUDE_LIMIT_RESET_OUTCOMES = [
  "reset",
  "already_used",
  "not_limited",
  "cooldown",
  "ineligible",
  "unavailable",
] as const;
export type ClaudeLimitResetOutcome = (typeof CLAUDE_LIMIT_RESET_OUTCOMES)[number];

export interface ClaudeLimitResetResult {
  readonly schema_version: typeof CLAUDE_LIMIT_RESET_SCHEMA_VERSION;
  readonly program: ClaudeLimitResetProgram;
  readonly outcome: ClaudeLimitResetOutcome;
  readonly reason: string | null;
  readonly resets_left: number | null;
  readonly next_available_at: number | null;
  readonly cooldown_until: number | null;
  readonly weekly_resets_at: number | null;
}

export interface UsageResult extends Reachable {
  readonly providers: ProviderUsage[];
}

export const AUTO_RESUME_SCHEMA_VERSION = "agent-session.auto-resume.v1";

export type AutoResumeState =
  | "disabled"
  | "enabled"
  | "armed"
  | "scheduled"
  | "switching_account"
  | "checking"
  | "resumed"
  | "cancelled"
  | "transient_failure"
  | "terminal_failure"
  | "unknown";

export type AutoResumeFailureReason =
  | "state_unavailable"
  | "manual_input"
  | "account_switch"
  | "usage_unavailable"
  | "usage_window_not_exhausted"
  | "exhausted_reset_unavailable"
  | "session_state_changed"
  | "submission_outcome_unknown"
  | "provider_unsupported"
  | "scheduler_error"
  | "no_account_available"
  | "account_switch_failed"
  | "unknown";

export type AutoResumeRecoveryPolicy =
  | "wait_for_reset"
  | "next_account_then_resume"
  | "unknown";

export interface AutoResumeStatus {
  readonly schema_version: typeof AUTO_RESUME_SCHEMA_VERSION;
  readonly supported: boolean;
  readonly enabled: boolean;
  readonly recovery_policy?: AutoResumeRecoveryPolicy;
  readonly state: AutoResumeState;
  readonly scheduled_at?: string;
  readonly failure_reason?: AutoResumeFailureReason;
}

const AUTO_RESUME_STATES = new Set<AutoResumeState>([
  "disabled",
  "enabled",
  "armed",
  "scheduled",
  "switching_account",
  "checking",
  "resumed",
  "cancelled",
  "transient_failure",
  "terminal_failure",
]);

const AUTO_RESUME_FAILURE_REASONS = new Set<AutoResumeFailureReason>([
  "state_unavailable",
  "manual_input",
  "account_switch",
  "usage_unavailable",
  "usage_window_not_exhausted",
  "exhausted_reset_unavailable",
  "session_state_changed",
  "submission_outcome_unknown",
  "provider_unsupported",
  "scheduler_error",
  "no_account_available",
  "account_switch_failed",
]);
const AUTO_RESUME_RECOVERY_POLICIES = new Set<AutoResumeRecoveryPolicy>([
  "wait_for_reset",
  "next_account_then_resume",
]);

function rfc3339(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 64) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) return undefined;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1 || month > 12 || day < 1 || day > (daysInMonth[month - 1] ?? 0) ||
    Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText) > 59 ||
    Number(offsetHourText ?? 0) > 23 || Number(offsetMinuteText ?? 0) > 59
  ) return undefined;
  return Number.isFinite(Date.parse(value)) ? value : undefined;
}

/**
 * Fail-closed consumer normalization for the additive daemon projection.
 * Only the documented v1 fields cross the trust boundary; future enum values
 * become `unknown`, which callers must never interpret as permission to send.
 */
export function normalizeAutoResumeStatus(value: unknown): AutoResumeStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    raw.schema_version !== AUTO_RESUME_SCHEMA_VERSION ||
    typeof raw.supported !== "boolean" ||
    typeof raw.enabled !== "boolean" ||
    typeof raw.state !== "string"
  ) return null;
  const scheduledAt = raw.scheduled_at === undefined ? undefined : rfc3339(raw.scheduled_at);
  if (raw.scheduled_at !== undefined && scheduledAt === undefined) return null;
  if (raw.failure_reason !== undefined && typeof raw.failure_reason !== "string") return null;
  const state = AUTO_RESUME_STATES.has(raw.state as AutoResumeState)
    ? raw.state as AutoResumeState
    : "unknown";
  const failureReason = raw.failure_reason === undefined
    ? undefined
    : AUTO_RESUME_FAILURE_REASONS.has(raw.failure_reason as AutoResumeFailureReason)
      ? raw.failure_reason as AutoResumeFailureReason
      : "unknown";
  const recoveryPolicy = raw.recovery_policy === undefined
    ? undefined
    : typeof raw.recovery_policy === "string"
      ? AUTO_RESUME_RECOVERY_POLICIES.has(raw.recovery_policy as AutoResumeRecoveryPolicy)
        ? raw.recovery_policy as AutoResumeRecoveryPolicy
        : "unknown"
      : null;
  if (recoveryPolicy === null) return null;
  return {
    schema_version: AUTO_RESUME_SCHEMA_VERSION,
    supported: raw.supported,
    enabled: raw.enabled,
    ...(recoveryPolicy ? { recovery_policy: recoveryPolicy } : {}),
    state,
    ...(scheduledAt ? { scheduled_at: scheduledAt } : {}),
    ...(failureReason ? { failure_reason: failureReason } : {}),
  };
}

// Codex and Claude share one account model: a per-machine inventory of broker
// nicknames, a per-session binding the daemon projects as `<provider>_account`,
// a switch through `PUT /api/sessions/:machine/:id/account`, and a provider
// default. They differ where the providers do: a Codex session switches live
// (or queues for the next turn), while Claude Code has no live credential swap,
// so a Claude switch restarts the session and resumes it on the new account.
// One nickname rule for provider account selections shared with host brokers
// and the agent-session daemon. A name that starts with
// `.`, `_` or `-` is refused even where an older broker would list it.
export const ACCOUNT_NICKNAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function normalizeAccountNickname(value: unknown): string | null {
  return typeof value === "string" && ACCOUNT_NICKNAME.test(value) ? value : null;
}

// The name that makes a usage entry's account its provider's default: a Codex
// entry is keyed by its nickname; other supported providers use the explicit
// token-free switch key supplied by the distribution. Other providers have
// no switchable default.
export function usageSwitchKey(
  entry: { readonly provider: string; readonly account: string | null; readonly switch_key?: string },
): string | undefined {
  if (entry.provider === "codex") return normalizeAccountNickname(entry.account) ?? undefined;
  if (entry.provider === "claude") return normalizeAccountNickname(entry.switch_key) ?? undefined;
  return undefined;
}

// Absent stays undefined; present but invalid is null, which rejects the view.
function optionalNickname(value: unknown): string | undefined | null {
  return value === undefined ? undefined : normalizeAccountNickname(value);
}

// Daemon budgets for work beyond the default daemon timeout, shared by the edge
// (daemon request) and the UI (which adds a transport margin on top).
export const ACCOUNT_CREATE_TIMEOUT_MS: Readonly<Record<AccountProvider, number>> = {
  codex: 75_000,
  // Up to three bounded (10 s) broker calls — list, select, materialize —
  // before tmux starts.
  claude: 45_000,
};
// A create that carries a prompt returns only after the daemon pasted it, which
// can take over a minute. Coordination clients allow a create request up to
// 120 s, so the edge waits that long plus a response margin and a create that
// succeeds inside that window is not reported as an unknown outcome. This does
// not extend any caller's own request ceiling.
export const PROMPT_CREATE_TIMEOUT_MS = 125_000;
// A Codex switch applies live; a Claude switch may restart the idle session.
export const ACCOUNT_SWITCH_TIMEOUT_MS = 40_000;

export function createSessionTimeoutMs(body: {
  readonly codex_account?: unknown;
  readonly claude_account?: unknown;
  readonly prompt?: unknown;
  readonly [key: string]: unknown;
}): number | undefined {
  // The daemon binds its default Codex account to a Codex create that names
  // none, so every Codex create carries the Codex binding budget.
  const account = ACCOUNT_PROVIDERS.find((provider) => body[`${provider}_account`] !== undefined)
    ?? (body.agent === "codex" ? "codex" : undefined);
  const prompt = typeof body.prompt === "string" && body.prompt.trim() ? PROMPT_CREATE_TIMEOUT_MS : 0;
  // The daemon binds the account before it starts the pane and pastes the prompt.
  const total = (account ? ACCOUNT_CREATE_TIMEOUT_MS[account] : 0) + prompt;
  return total > 0 ? total : undefined;
}

export const CODEX_ACCOUNT_SCHEMA_VERSION = "agent-session.codex-account.v1";
export const CODEX_ACCOUNT_READINESS_SCHEMA_VERSION = "agent-session.codex-account-readiness.v1";

export type CodexAccountState =
  | "unsupported"
  | "unbound"
  | "pending"
  | "bound"
  | "failed"
  | "unknown";

export type CodexAccountFailureReason =
  | "broker_failed"
  | "apply_failed"
  | "refresh_failed"
  | "binding_invalid"
  | "manual_input"
  | "unknown";

type CodexNextAccountState = "queued" | "applying" | "failed" | "unknown";

type CodexNextAccountFailureReason =
  | "broker_failed"
  | "apply_failed"
  | "refresh_failed"
  | "next_invalid"
  | "unknown";

export interface CodexNextAccountStatus {
  readonly account?: string;
  readonly revision: number;
  readonly state: CodexNextAccountState;
  readonly failure_reason?: CodexNextAccountFailureReason;
}

export interface CodexAccountStatus {
  readonly schema_version: typeof CODEX_ACCOUNT_SCHEMA_VERSION;
  readonly supported: boolean;
  readonly state: CodexAccountState;
  readonly selected_account?: string;
  readonly effective_account?: string;
  readonly selection_source?: "default_at_launch" | "explicit" | "auto_failover" | "unknown";
  readonly revision: number;
  readonly applied_runtime_id?: string;
  readonly failure_reason?: CodexAccountFailureReason;
  readonly next?: CodexNextAccountStatus;
}

export type CodexAccountMutationOutcome =
  | "applied"
  | "bound-next"
  | "unbound-queued"
  | "invalid";

export interface AccountSummary {
  readonly account: string;
  readonly label?: string;
  readonly plan?: string;
}

export type CodexRuntimeFallbackReason =
  | "codex-unavailable"
  | "codex-version-unrecognized"
  | "codex-version-too-old"
  | "codex-app-server-transport-unavailable"
  | "codex-app-server-runtime-dir-unavailable"
  | "codex-app-server-runtime-dir-unsafe"
  | "codex-app-server-socket-path-too-long"
  | "codex-app-server-runtime-unavailable";

export type CodexAccountReadinessReason = CodexRuntimeFallbackReason | "unknown";

export interface CodexAccountReadiness {
  readonly schema_version: typeof CODEX_ACCOUNT_READINESS_SCHEMA_VERSION;
  readonly supported: boolean;
  readonly provider_version?: string;
  readonly reason_code?: CodexAccountReadinessReason;
}

/** A machine's broker accounts for one provider. */
export interface AccountInventory {
  readonly accounts: readonly AccountSummary[];
  /** Codex only; omitted by older daemons, whose consumers keep their established behavior. */
  readonly readiness?: CodexAccountReadiness;
  /** Selection strategies the broker advertises, when the daemon reports them. */
  readonly selection_strategies?: readonly string[];
}

const CODEX_ACCOUNT_STATES = new Set<CodexAccountState>([
  "unsupported",
  "unbound",
  "pending",
  "bound",
  "failed",
]);
const CODEX_ACCOUNT_FAILURE_REASONS = new Set<CodexAccountFailureReason>([
  "broker_failed",
  "apply_failed",
  "refresh_failed",
  "binding_invalid",
  "manual_input",
]);
const CODEX_NEXT_ACCOUNT_STATES = new Set<CodexNextAccountState>([
  "queued",
  "applying",
  "failed",
]);
const CODEX_NEXT_ACCOUNT_FAILURE_REASONS = new Set<CodexNextAccountFailureReason>([
  "broker_failed",
  "apply_failed",
  "refresh_failed",
  "next_invalid",
]);
const CODEX_ACCOUNT_SELECTION_SOURCES = new Set([
  "default_at_launch",
  "explicit",
  "auto_failover",
]);
const CODEX_PROVIDER_VERSION = /^\d+\.\d+\.\d+$/;
const CODEX_ACCOUNT_READINESS_REASONS = new Set<CodexAccountReadinessReason>([
  "codex-unavailable",
  "codex-version-unrecognized",
  "codex-version-too-old",
  "codex-app-server-transport-unavailable",
  "codex-app-server-runtime-dir-unavailable",
  "codex-app-server-runtime-dir-unsafe",
  "codex-app-server-socket-path-too-long",
  "codex-app-server-runtime-unavailable",
]);

function boundedMetadata(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    return undefined;
  }
  return value;
}

function invalidCodexNextAccountStatus(): CodexNextAccountStatus {
  return {
    revision: 0,
    state: "unknown",
    failure_reason: "unknown",
  };
}

function normalizeCodexNextAccountStatus(value: unknown): CodexNextAccountStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.state !== "string"
    || typeof raw.revision !== "number"
    || !Number.isSafeInteger(raw.revision)
    || raw.revision < 0
  ) return null;
  const account = optionalNickname(raw.account);
  if (account === null || (raw.failure_reason !== undefined && typeof raw.failure_reason !== "string")) return null;
  const state = CODEX_NEXT_ACCOUNT_STATES.has(raw.state as CodexNextAccountState)
    ? raw.state as CodexNextAccountState
    : "unknown";
  const failureReason = raw.failure_reason === undefined
    ? undefined
    : CODEX_NEXT_ACCOUNT_FAILURE_REASONS.has(raw.failure_reason as CodexNextAccountFailureReason)
      ? raw.failure_reason as CodexNextAccountFailureReason
      : "unknown";
  const invalidSentinel = state === "failed"
    && raw.revision === 0
    && account === undefined
    && failureReason === "next_invalid";
  if (
    (state === "queued" || state === "applying")
      && (raw.revision < 1 || !account || failureReason !== undefined)
  ) return null;
  if (
    state === "failed"
      && !invalidSentinel
      && (raw.revision < 1 || !account || failureReason === undefined || failureReason === "next_invalid")
  ) return null;
  if (state === "unknown" && (raw.revision < 1 || !account)) return null;
  return {
    ...(account ? { account } : {}),
    revision: raw.revision,
    state,
    ...(failureReason ? { failure_reason: failureReason } : {}),
  };
}

export function normalizeCodexAccountStatus(value: unknown): CodexAccountStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    raw.schema_version !== CODEX_ACCOUNT_SCHEMA_VERSION
    || typeof raw.supported !== "boolean"
    || typeof raw.state !== "string"
    || typeof raw.revision !== "number"
    || !Number.isSafeInteger(raw.revision)
    || raw.revision < 0
  ) return null;
  const selectedAccount = optionalNickname(raw.selected_account);
  if (selectedAccount === null) return null;
  const effectiveAccount = optionalNickname(raw.effective_account);
  if (effectiveAccount === null || (effectiveAccount && effectiveAccount !== selectedAccount)) return null;
  const selectionSource = raw.selection_source === undefined
    ? undefined
    : typeof raw.selection_source === "string"
      ? CODEX_ACCOUNT_SELECTION_SOURCES.has(raw.selection_source)
        ? raw.selection_source as "default_at_launch" | "explicit" | "auto_failover"
        : "unknown"
      : null;
  if (selectionSource === null || (selectionSource && !selectedAccount)) return null;
  const runtimeId = raw.applied_runtime_id === undefined
    ? undefined
    : boundedMetadata(raw.applied_runtime_id, 128);
  if (raw.applied_runtime_id !== undefined && runtimeId === undefined) return null;
  if (raw.failure_reason !== undefined && typeof raw.failure_reason !== "string") return null;
  const state = CODEX_ACCOUNT_STATES.has(raw.state as CodexAccountState)
    ? raw.state as CodexAccountState
    : "unknown";
  const failureReason = raw.failure_reason === undefined
    ? undefined
    : CODEX_ACCOUNT_FAILURE_REASONS.has(raw.failure_reason as CodexAccountFailureReason)
      ? raw.failure_reason as CodexAccountFailureReason
      : "unknown";
  const next = raw.next === undefined ? undefined : normalizeCodexNextAccountStatus(raw.next);
  if (!raw.supported && state !== "unsupported") return null;
  if (raw.supported && state === "unsupported") return null;
  if (state === "unbound" && (raw.revision !== 0 || selectedAccount || effectiveAccount || selectionSource || runtimeId || failureReason)) return null;
  if (state === "pending" && (raw.revision < 1 || !selectedAccount || effectiveAccount || runtimeId)) return null;
  if (state === "bound" && (raw.revision < 1 || !selectedAccount || !runtimeId || failureReason)) return null;
  if (
    state === "failed"
    && !(failureReason === "binding_invalid" && raw.revision === 0 && !selectedAccount && !runtimeId)
    && (raw.revision < 1 || !selectedAccount || effectiveAccount || runtimeId)
  ) return null;
  return {
    schema_version: CODEX_ACCOUNT_SCHEMA_VERSION,
    supported: raw.supported,
    state,
    revision: raw.revision,
    ...(selectedAccount ? { selected_account: selectedAccount } : {}),
    ...(effectiveAccount ? { effective_account: effectiveAccount } : {}),
    ...(selectionSource ? { selection_source: selectionSource } : {}),
    ...(runtimeId ? { applied_runtime_id: runtimeId } : {}),
    ...(failureReason ? { failure_reason: failureReason } : {}),
    ...(raw.next === undefined ? {} : { next: next ?? invalidCodexNextAccountStatus() }),
  };
}

export function classifyCodexAccountMutationOutcome(
  account: CodexAccountStatus,
  requestedAccount: string,
  expectedSessionIncarnation: string,
): CodexAccountMutationOutcome {
  const authoritativeCurrent = account.supported
    && account.state === "bound"
    && account.revision > 0
    && account.applied_runtime_id === expectedSessionIncarnation;
  if (authoritativeCurrent) {
    if (account.selected_account === requestedAccount) {
      return account.next === undefined ? "applied" : "invalid";
    }
    const next = account.next;
    if (
      next?.account === requestedAccount
      && next.revision > 0
      && (
        next.state === "queued"
        || next.state === "applying"
        || next.state === "failed"
        || next.state === "unknown"
      )
    ) {
      return "bound-next";
    }
    return "invalid";
  }
  if (
    account.supported
    && account.state === "unbound"
    && account.next?.account === requestedAccount
    && account.next.revision > 0
    && account.next.state === "queued"
  ) {
    return "unbound-queued";
  }
  return "invalid";
}

export function normalizeAccountSummaries(value: unknown): AccountSummary[] {
  if (!Array.isArray(value)) return [];
  const accounts: AccountSummary[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw.account !== "string" || !ACCOUNT_NICKNAME.test(raw.account) || seen.has(raw.account)) continue;
    const label = raw.label === undefined || raw.label === null ? undefined : boundedMetadata(raw.label, 64);
    const plan = raw.plan === undefined || raw.plan === null ? undefined : boundedMetadata(raw.plan, 128);
    if ((raw.label !== undefined && raw.label !== null && !label) || (raw.plan !== undefined && raw.plan !== null && !plan)) continue;
    seen.add(raw.account);
    accounts.push({
      account: raw.account,
      ...(label ? { label } : {}),
      ...(plan ? { plan } : {}),
    });
  }
  return accounts;
}

export function normalizeCodexAccountReadiness(value: unknown): CodexAccountReadiness | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    raw.schema_version !== CODEX_ACCOUNT_READINESS_SCHEMA_VERSION
    || typeof raw.supported !== "boolean"
  ) return null;
  const providerVersion = raw.provider_version === undefined
    ? undefined
    : typeof raw.provider_version === "string"
        && raw.provider_version.length <= 32
        && CODEX_PROVIDER_VERSION.test(raw.provider_version)
      ? raw.provider_version
      : null;
  if (providerVersion === null) return null;
  if (raw.reason_code !== undefined && typeof raw.reason_code !== "string") return null;
  const reasonCode = raw.reason_code === undefined
    ? undefined
    : CODEX_ACCOUNT_READINESS_REASONS.has(raw.reason_code as CodexAccountReadinessReason)
      ? raw.reason_code as CodexAccountReadinessReason
      : "unknown";
  if (raw.supported === (reasonCode !== undefined)) return null;
  return {
    schema_version: CODEX_ACCOUNT_READINESS_SCHEMA_VERSION,
    supported: raw.supported,
    ...(providerVersion ? { provider_version: providerVersion } : {}),
    ...(reasonCode ? { reason_code: reasonCode } : {}),
  };
}

const CLAUDE_ACCOUNT_SCHEMA_VERSION = "agent-session.claude-account.v1";

type ClaudeAccountState = "unsupported" | "unbound" | "bound" | "failed" | "unknown";

/**
 * A Claude switch is a durable intent: Claude Code has no live credential swap,
 * so the daemon applies it by restarting the session and resuming the
 * conversation in the new account's configuration directory.
 */
interface ClaudeNextAccountStatus {
  readonly account?: string;
  readonly revision: number;
  readonly state: "queued" | "failed" | "unknown";
}

/** Path-free daemon projection `agent-session.claude-account.v1`. */
export interface ClaudeAccountStatus {
  readonly schema_version: typeof CLAUDE_ACCOUNT_SCHEMA_VERSION;
  readonly supported: boolean;
  readonly state: ClaudeAccountState;
  readonly selected_account?: string;
  readonly selection_source?: "default_at_launch" | "explicit" | "unknown";
  readonly revision: number;
  readonly applied_runtime_id?: string;
  readonly failure_reason?: "binding_invalid" | "unknown";
  readonly next?: ClaudeNextAccountStatus;
}

export type ClaudeAccountMutationOutcome = "applied" | "queued" | "invalid";

const CLAUDE_ACCOUNT_STATES = new Set<ClaudeAccountState>(["unsupported", "unbound", "bound", "failed"]);
const CLAUDE_ACCOUNT_SELECTION_SOURCES = new Set(["default_at_launch", "explicit"]);

function normalizeClaudeNextAccountStatus(value: unknown): ClaudeNextAccountStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const account = optionalNickname(raw.account);
  if (
    account === null
    || typeof raw.state !== "string"
    || typeof raw.revision !== "number"
    || !Number.isSafeInteger(raw.revision)
    || raw.revision < 0
  ) return null;
  const state = raw.state === "queued" || raw.state === "failed" ? raw.state : "unknown";
  if (state === "queued" && (!account || raw.revision < 1)) return null;
  return { ...(account ? { account } : {}), revision: raw.revision, state };
}

export function normalizeClaudeAccountStatus(value: unknown): ClaudeAccountStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    raw.schema_version !== CLAUDE_ACCOUNT_SCHEMA_VERSION
    || typeof raw.supported !== "boolean"
    || typeof raw.state !== "string"
    || typeof raw.revision !== "number"
    || !Number.isSafeInteger(raw.revision)
    || raw.revision < 0
  ) return null;
  const selectedAccount = optionalNickname(raw.selected_account);
  if (selectedAccount === null) return null;
  if (raw.selection_source !== undefined && typeof raw.selection_source !== "string") return null;
  const selectionSource = raw.selection_source === undefined
    ? undefined
    : CLAUDE_ACCOUNT_SELECTION_SOURCES.has(raw.selection_source as string)
      ? raw.selection_source as "default_at_launch" | "explicit"
      : "unknown";
  const runtimeId = raw.applied_runtime_id === undefined
    ? undefined
    : boundedMetadata(raw.applied_runtime_id, 128);
  if (raw.applied_runtime_id !== undefined && runtimeId === undefined) return null;
  if (raw.failure_reason !== undefined && typeof raw.failure_reason !== "string") return null;
  const failureReason = raw.failure_reason === undefined
    ? undefined
    : raw.failure_reason === "binding_invalid" ? "binding_invalid" : "unknown";
  const state = CLAUDE_ACCOUNT_STATES.has(raw.state as ClaudeAccountState)
    ? raw.state as ClaudeAccountState
    : "unknown";
  if (raw.supported !== (state !== "unsupported")) return null;
  if (state === "bound" && (raw.revision < 1 || !selectedAccount)) return null;
  const next = raw.next === undefined ? undefined : normalizeClaudeNextAccountStatus(raw.next);
  return {
    schema_version: CLAUDE_ACCOUNT_SCHEMA_VERSION,
    supported: raw.supported,
    state,
    ...(selectedAccount ? { selected_account: selectedAccount } : {}),
    ...(selectionSource ? { selection_source: selectionSource } : {}),
    revision: raw.revision,
    ...(runtimeId ? { applied_runtime_id: runtimeId } : {}),
    ...(failureReason ? { failure_reason: failureReason } : {}),
    // A malformed next intent stays visible as unknown, as for Codex.
    ...(raw.next === undefined ? {} : { next: next ?? { revision: 0, state: "unknown" } }),
  };
}

const SELECTION_STRATEGY = /^[a-z][a-z0-9_]{0,31}$/;

export function normalizeSelectionStrategies(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string =>
    typeof item === "string" && SELECTION_STRATEGY.test(item)))].slice(0, 8);
}

/**
 * A confirmed Claude switch either now runs on the requested account (the
 * view names the runtime the response reports, which is a new incarnation when
 * the daemon restarted an idle session) or durably queued it for the next
 * resume against the same, fenced incarnation.
 */
export function classifyClaudeAccountMutationOutcome(
  account: ClaudeAccountStatus,
  requestedAccount: string,
  expectedSessionIncarnation: string,
  responseSessionIncarnation: unknown,
): ClaudeAccountMutationOutcome {
  if (!account.supported || typeof responseSessionIncarnation !== "string") return "invalid";
  if (
    account.state === "bound"
    && account.selected_account === requestedAccount
    && account.next === undefined
    && account.applied_runtime_id === responseSessionIncarnation
  ) {
    return "applied";
  }
  if (
    (account.state === "bound" || account.state === "unbound")
    && account.selected_account !== requestedAccount
    && account.next?.state === "queued"
    && account.next.account === requestedAccount
    && responseSessionIncarnation === expectedSessionIncarnation
  ) {
    return "queued";
  }
  return "invalid";
}

export interface AccountStatusByProvider {
  readonly codex: CodexAccountStatus;
  readonly claude: ClaudeAccountStatus;
}

export function normalizeAccountStatus<P extends AccountProvider>(
  provider: P,
  value: unknown,
): AccountStatusByProvider[P] | null {
  return (provider === "codex"
    ? normalizeCodexAccountStatus(value)
    : normalizeClaudeAccountStatus(value)) as AccountStatusByProvider[P] | null;
}

/**
 * A create that named an account is confirmed only by a supported binding to
 * that account, applied to the runtime the create started.
 */
export function confirmsCreatedAccountBinding(
  account: CodexAccountStatus | ClaudeAccountStatus,
  requestedAccount: string,
  sessionIncarnation: string,
): boolean {
  return account.supported
    && account.state === "bound"
    && account.selected_account === requestedAccount
    && account.revision > 0
    && account.applied_runtime_id === sessionIncarnation;
}

/**
 * Whether a switch answer confirms the requested account for this provider: a
 * Codex switch applied, queued behind the running turn, or queued on an
 * unbound session; a Claude switch applied by a restart (the answer names the
 * new incarnation) or queued for the next resume.
 */
export function confirmsAccountSwitch<P extends AccountProvider>(
  provider: P,
  account: AccountStatusByProvider[P],
  requestedAccount: string,
  expectedSessionIncarnation: string,
  responseSessionIncarnation: unknown,
): boolean {
  if (provider === "claude") {
    return classifyClaudeAccountMutationOutcome(
      account as ClaudeAccountStatus,
      requestedAccount,
      expectedSessionIncarnation,
      responseSessionIncarnation,
    ) !== "invalid";
  }
  const outcome = classifyCodexAccountMutationOutcome(
    account as CodexAccountStatus,
    requestedAccount,
    expectedSessionIncarnation,
  );
  return outcome === "applied"
    || outcome === "bound-next"
    || (outcome === "unbound-queued" && responseSessionIncarnation === expectedSessionIncarnation);
}

export const STARTUP_SCHEMA_VERSION = "agent-session.startup.v1";

export type StartupState = "starting" | "ready" | "failed";

export type StartupStage =
  | "record"
  | "tmux"
  | "runtime"
  | "app_server"
  | "proxy"
  | "provider_client"
  | "initial_connection";

export type StartupFailureCode =
  | "runtime-helper-unavailable"
  | "agent-binary-unavailable"
  | "working-directory-unavailable"
  | "terminal-runtime-create-failed"
  | "app-server-start-failed"
  | "proxy-start-failed"
  | "provider-client-exited"
  | "provider-configuration-rejected"
  | "startup-timeout"
  | "startup-exited";

interface StartupBase {
  readonly schema_version: typeof STARTUP_SCHEMA_VERSION;
  readonly stage: StartupStage;
  readonly started_at: string;
  readonly runtime_fallback?: CodexRuntimeFallbackReason;
}

export interface StartupProgressStatus extends StartupBase {
  readonly state: "starting" | "ready";
}

export type StartupCleanupState = "pending" | "blocked";

/** Producer allowlist; every value is a code, never a diagnostic string. */
export type StartupCleanupReason =
  | "session_still_running"
  | "process_boundary_live"
  | "runtime_identity_changed"
  | "runtime_identity_unavailable"
  | "termination_failed"
  | "termination_timeout"
  | "verification_failed"
  | "cleanup_unavailable"
  | "unknown";

/**
 * Secondary state for a failed launch whose cleanup could not finish. It never
 * replaces the startup failure: the original error is what explains why the
 * session failed, and a termination error reported in its place would hide it.
 */
export interface StartupCleanupStatus {
  readonly state: StartupCleanupState;
  readonly reason: StartupCleanupReason;
}

export interface StartupFailureStatus extends StartupBase {
  readonly state: "failed";
  readonly failure_code: StartupFailureCode;
  readonly message: string;
  readonly occurred_at: string;
  readonly retry_safe: boolean;
  /** Absent when cleanup completed or was never attempted. */
  readonly cleanup?: StartupCleanupStatus;
}

export type StartupStatus = StartupProgressStatus | StartupFailureStatus;

const STARTUP_STAGES = new Set<StartupStage>([
  "record",
  "tmux",
  "runtime",
  "app_server",
  "proxy",
  "provider_client",
  "initial_connection",
]);

interface StartupFailureContract {
  readonly stage?: StartupStage;
  readonly message: string;
  readonly retrySafe: boolean;
}

const STARTUP_FAILURE_CONTRACTS: Readonly<Record<StartupFailureCode, StartupFailureContract>> = {
  "runtime-helper-unavailable": {
    stage: "proxy",
    message: "Session runtime helper is unavailable after an upgrade.",
    retrySafe: true,
  },
  "agent-binary-unavailable": {
    stage: "runtime",
    message: "The selected agent CLI could not be started.",
    retrySafe: false,
  },
  "working-directory-unavailable": {
    stage: "record",
    message: "The selected working directory is unavailable.",
    retrySafe: false,
  },
  "terminal-runtime-create-failed": {
    stage: "tmux",
    message: "The terminal runtime could not be created.",
    retrySafe: true,
  },
  "app-server-start-failed": {
    stage: "app_server",
    message: "The agent control server did not become ready.",
    retrySafe: true,
  },
  "proxy-start-failed": {
    stage: "proxy",
    message: "Agent Console could not connect the terminal to the agent runtime.",
    retrySafe: true,
  },
  "provider-client-exited": {
    stage: "provider_client",
    message: "The agent exited before the session was ready.",
    retrySafe: true,
  },
  "provider-configuration-rejected": {
    stage: "provider_client",
    message: "The agent needs configuration or sign-in on this machine.",
    retrySafe: false,
  },
  "startup-timeout": {
    message: "Session startup timed out; the outcome may be uncertain.",
    retrySafe: false,
  },
  "startup-exited": {
    message: "The session stopped during startup.",
    retrySafe: true,
  },
};

function startupFailureCode(value: unknown): StartupFailureCode | undefined {
  return typeof value === "string" && Object.hasOwn(STARTUP_FAILURE_CONTRACTS, value)
    ? value as StartupFailureCode
    : undefined;
}

const STARTUP_CLEANUP_STATES = new Set<StartupCleanupState>(["pending", "blocked"]);
const STARTUP_CLEANUP_REASONS = new Set<StartupCleanupReason>([
  "session_still_running",
  "process_boundary_live",
  "runtime_identity_changed",
  "runtime_identity_unavailable",
  "termination_failed",
  "termination_timeout",
  "verification_failed",
  "cleanup_unavailable",
  "unknown",
]);

/**
 * Fail-closed cleanup caveat. Exactly a state and an allowlisted reason: an
 * extra field would be a channel for a pid, a tmux target, or a local path.
 */
function normalizeStartupCleanup(value: unknown): StartupCleanupStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw);
  if (
    keys.length !== 2
    || !STARTUP_CLEANUP_STATES.has(raw.state as StartupCleanupState)
    || !STARTUP_CLEANUP_REASONS.has(raw.reason as StartupCleanupReason)
  ) return null;
  return { state: raw.state as StartupCleanupState, reason: raw.reason as StartupCleanupReason };
}

/**
 * Fail-closed normalization for the metadata-only session startup projection.
 * Failure messages and retry permission must match the producer allowlist, so
 * raw daemon diagnostics cannot cross this boundary under a trusted field.
 */
export function normalizeStartupStatus(value: unknown): StartupStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const stage = typeof raw.stage === "string" && STARTUP_STAGES.has(raw.stage as StartupStage)
    ? raw.stage as StartupStage
    : undefined;
  const startedAt = rfc3339(raw.started_at);
  if (raw.schema_version !== STARTUP_SCHEMA_VERSION || !stage || !startedAt) return null;
  const runtimeFallback = typeof raw.runtime_fallback === "string"
    && CODEX_ACCOUNT_READINESS_REASONS.has(raw.runtime_fallback as CodexRuntimeFallbackReason)
    ? raw.runtime_fallback as CodexRuntimeFallbackReason : undefined;

  if (raw.state === "starting" || raw.state === "ready") {
    if (
      raw.failure_code !== undefined ||
      raw.message !== undefined ||
      raw.occurred_at !== undefined ||
      raw.retry_safe !== undefined ||
      raw.cleanup !== undefined
    ) return null;
    return {
      schema_version: STARTUP_SCHEMA_VERSION,
      state: raw.state,
      stage,
      started_at: startedAt,
      ...(runtimeFallback ? { runtime_fallback: runtimeFallback } : {}),
    };
  }
  if (raw.state !== "failed") return null;

  const failureCode = startupFailureCode(raw.failure_code);
  const occurredAt = rfc3339(raw.occurred_at);
  if (!failureCode || !occurredAt || typeof raw.message !== "string" || typeof raw.retry_safe !== "boolean") {
    return null;
  }
  const contract = STARTUP_FAILURE_CONTRACTS[failureCode];
  const cleanup = raw.cleanup === undefined ? null : normalizeStartupCleanup(raw.cleanup);
  if (
    (contract.stage !== undefined && contract.stage !== stage) ||
    contract.message !== raw.message ||
    contract.retrySafe !== raw.retry_safe ||
    (raw.cleanup !== undefined && cleanup === null)
  ) return null;
  return {
    schema_version: STARTUP_SCHEMA_VERSION,
    state: "failed",
    stage,
    started_at: startedAt,
    failure_code: failureCode,
    message: contract.message,
    occurred_at: occurredAt,
    retry_safe: contract.retrySafe,
    ...(cleanup ? { cleanup } : {}),
    ...(runtimeFallback ? { runtime_fallback: runtimeFallback } : {}),
  };
}

export type DebugEventSource = "client" | "edge" | "daemon" | "ws";

export interface DebugEvent {
  readonly seq: number;
  readonly at: string;
  readonly source: DebugEventSource;
  readonly request_id: string | null;
  readonly method: string | null;
  readonly route: string;
  readonly status: number | null;
  readonly ok: boolean | null;
  readonly duration_ms: number | null;
  readonly machine: string | null;
  readonly session_id: string | null;
  readonly error: string | null;
  readonly operation?: string | null;
  readonly phase?: string | null;
  readonly outcome?: string | null;
  readonly provenance?: string | null;
  readonly attempt_id?: string | null;
  readonly attempt?: number | null;
  // The failure envelope the edge already projects for a failed response, and
  // the per-route structured outcome tokens. Both sides record them so a
  // debug bundle explains a failure without retaining any request or response
  // body; every field is a bounded token from a producer-owned vocabulary.
  readonly code?: string | null;
  readonly retryable?: boolean;
  readonly next_action?: string | null;
  readonly recovery_strategy?: string | null;
  readonly recovery_safe_to_retry?: boolean;
  readonly failure_class?: string | null;
  readonly failure_stage?: string | null;
  readonly provider_kind?: string | null;
  readonly duration_bucket?: string | null;
}

export function debugMetadataToken(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(value)
    ? value
    : null;
}

export function normalizeDebugLifecycleMetadata(input: {
  readonly operation?: unknown;
  readonly phase?: unknown;
  readonly outcome?: unknown;
  readonly provenance?: unknown;
  readonly attempt_id?: unknown;
  readonly attempt?: unknown;
  readonly failure_class?: unknown;
  readonly failure_stage?: unknown;
  readonly provider_kind?: unknown;
  readonly duration_bucket?: unknown;
}): Partial<DebugEvent> {
  const token = debugMetadataToken;
  const operation = token(input.operation);
  const phase = token(input.phase);
  const outcome = token(input.outcome);
  const provenance = token(input.provenance);
  const attemptId = token(input.attempt_id);
  const failureClass = token(input.failure_class);
  const failureStage = token(input.failure_stage);
  const providerKind = token(input.provider_kind);
  const durationBucket = token(input.duration_bucket);
  const attempt = input.attempt;
  return {
    ...(operation ? { operation } : {}),
    ...(phase ? { phase } : {}),
    ...(outcome ? { outcome } : {}),
    ...(provenance ? { provenance } : {}),
    ...(attemptId ? { attempt_id: attemptId } : {}),
    ...(failureClass ? { failure_class: failureClass } : {}),
    ...(failureStage ? { failure_stage: failureStage } : {}),
    ...(providerKind ? { provider_kind: providerKind } : {}),
    ...(durationBucket ? { duration_bucket: durationBucket } : {}),
    ...(typeof attempt === "number" && Number.isSafeInteger(attempt) && attempt > 0 && attempt <= 100
      ? { attempt }
      : {}),
  };
}

export function isLayoutRevisionConflict(input: { method?: string | null; route: string; status?: number | null; error?: string | null; errorEnvelope?: unknown }): boolean {
  const envelope = input.errorEnvelope as { error?: { message?: unknown } } | undefined;
  return input.method?.toUpperCase() === "PUT" && input.route === "/api/layout" && input.status === 409
    && (input.error ?? envelope?.error?.message) === "layout revision conflict";
}

/** Projects the bounded diagnosis out of a failed `{ok:false,error}` envelope.
 *
 * The edge already answers "what went wrong and what should happen next" in a
 * stable vocabulary, but until now only `error.message` survived into the debug
 * rings. This keeps the decision fields and never the body: unrecognized or
 * unbounded values are dropped rather than truncated, so a free-text value can
 * never enter a ring through this path. */
export function normalizeDebugErrorEnvelope(value: unknown): Partial<DebugEvent> {
  if (!value || typeof value !== "object") return {};
  const envelope = value as { ok?: unknown; error?: unknown };
  if (envelope.ok !== false || !envelope.error || typeof envelope.error !== "object") return {};
  const error = envelope.error as {
    code?: unknown;
    details?: unknown;
  };
  const details = error.details && typeof error.details === "object"
    ? error.details as { retryable?: unknown; next_action?: unknown; recovery?: unknown }
    : undefined;
  const recovery = details?.recovery && typeof details.recovery === "object"
    ? details.recovery as { strategy?: unknown; safe_to_retry?: unknown }
    : undefined;
  const code = debugMetadataToken(error.code);
  const nextAction = debugMetadataToken(details?.next_action);
  const strategy = debugMetadataToken(recovery?.strategy);
  return {
    ...(code ? { code } : {}),
    ...(typeof details?.retryable === "boolean" ? { retryable: details.retryable } : {}),
    ...(nextAction ? { next_action: nextAction } : {}),
    ...(strategy ? { recovery_strategy: strategy } : {}),
    ...(typeof recovery?.safe_to_retry === "boolean"
      ? { recovery_safe_to_retry: recovery.safe_to_retry }
      : {}),
  };
}

/** Debug rows split into two populations with very different value per row.
 *
 * A console polls two machines every few seconds, so a single 1,000-row ring
 * holds only minutes of history and a failure reported an hour later has
 * already been evicted by successful polls. A failure or a lifecycle outcome is
 * kept in a separate ring with its own capacity and retention, so routine
 * traffic can never push it out. */
export type DebugEventClass = "signal" | "traffic";

export function classifyDebugEvent(
  event: Pick<DebugEvent, "ok" | "operation" | "code">,
): DebugEventClass {
  return event.ok === false || Boolean(event.operation) || Boolean(event.code)
    ? "signal"
    : "traffic";
}

/** Groups a de-identified route into the families an operator filters by. The
 * route is already redacted, so this only reads its stable leading segments. */
export function debugRouteFamily(route: string): string {
  const parts = route.split("/").filter(Boolean);
  if (parts[0] === "title-lifecycle") return "lifecycle";
  if (parts[0] !== "api") return parts[0] ?? "other";
  const group = parts[1];
  if (group === "sessions" || group === "machines") {
    const tail = parts[parts.length - 1];
    if (parts.length > 3 && tail && !tail.startsWith(":")) return `${group}/${tail}`;
    return group ?? "other";
  }
  return group ?? "other";
}

export interface DebugEventsResult {
  readonly events: readonly DebugEvent[];
  readonly generated_at: string;
  readonly max_events: number;
  /** Capacity of the separate ring that holds failures and lifecycle rows, so
   * routine polling cannot evict the evidence a failure report needs. */
  readonly max_signal_events?: number;
}

export type DebugClientSurface = "web" | "macos" | "android" | "tauri" | "unknown";

export interface DebugClientInfo {
  readonly version: string;
  readonly build_sha: string | null;
  readonly surface: DebugClientSurface;
  readonly url: string | null;
  readonly server_url: string | null;
  readonly user_agent: string | null;
}

export interface DebugDiagnosticProbe {
  readonly name: string;
  readonly route: string;
  readonly request_id: string | null;
  readonly status: number | null;
  readonly ok: boolean;
  readonly duration_ms: number | null;
  readonly error: string | null;
  readonly version?: string;
}

export interface DebugDiagnosticResult {
  readonly generated_at: string;
  readonly ok: boolean;
  readonly probes: readonly DebugDiagnosticProbe[];
}

export interface DebugAgentBundle {
  readonly kind: "agent-console.debug_bundle.v1";
  readonly generated_at: string;
  readonly app: DebugClientInfo;
  readonly diagnostics: DebugDiagnosticResult | null;
  readonly session_startup_failure?: SessionStartupFailureDiagnostic;
  /** The active event filter when the bundle was copied, so a reader can tell
   * a narrowed export from a complete one. Absent when nothing was filtered. */
  readonly filter?: string;
  /** The daemon's own retitle receipts for the session under investigation,
   * when they were loaded. Content-free by contract. */
  readonly retitle_receipts?: SessionRetitleV3Receipts;
  readonly client_events: readonly DebugEvent[];
  readonly edge_events: readonly DebugEvent[];
}

export interface SessionStartupFailureDiagnostic {
  readonly machine: string;
  readonly session_id: string;
  readonly startup: StartupFailureStatus;
}
