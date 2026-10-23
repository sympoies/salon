import {normalizeSessionRole, type SessionRole} from "@agent-console/shared/lineage";
import { normalizeSessionModelSettings } from "@agent-console/shared/session-model";
import { objectProp as object } from "../normalize.ts";

// Session board record contract (nils-cli
// crates/agent-session/docs/specs/session-board-v1.md). Daemon responses are
// peer-supplied data: every record is validated against the v1 field table and
// re-projected to exactly that allowlist, so unknown upstream fields never reach
// board.sqlite or a board reader.

export const BOARD_RECORD_SCHEMA = "agent-session.board-record.v1";
export const BOARD_SNAPSHOT_SCHEMA = "agent-session.board.v1";
export const BOARD_CLOSED_SCHEMA = "agent-session.board-closed.v1";

const DAY_MS = 24 * 60 * 60 * 1000;

// Retention windows a deployment may configure. `mo` is 31 days, the maximum.
export const BOARD_RETENTIONS = {
  "3d": 3 * DAY_MS,
  "7d": 7 * DAY_MS,
  "2w": 14 * DAY_MS,
  "1mo": 31 * DAY_MS,
} as const;
export type BoardRetention = keyof typeof BOARD_RETENTIONS;
export const DEFAULT_BOARD_RETENTION: BoardRetention = "3d";

export function parseBoardRetention(raw: string | undefined): BoardRetention {
  const value = (raw ?? "").trim();
  if (value === "") return DEFAULT_BOARD_RETENTION;
  if (Object.hasOwn(BOARD_RETENTIONS, value)) return value as BoardRetention;
  throw new Error("AGENT_CONSOLE_BOARD_RETENTION must be one of 3d, 7d, 2w, 1mo");
}

export type BoardState = "live" | "stopped" | "closed";
export type BoardCloseReason = "deleted" | "archived" | "exited" | "vanished";

export interface BoardTurnState {
  readonly phase: string;
  readonly phase_changed_at: string;
  readonly current_turn: {
    readonly last_progress_at: string | null;
    readonly attention: {
      readonly kind: string;
      readonly requested_at: string | null;
      // Optional, bounded detail of a pending request (#873).
      readonly pending_count?: number;
      readonly certainty?: "exact" | "conservative";
    } | null;
  } | null;
  readonly last_turn: { readonly outcome: string | null } | null;
  readonly source: { readonly confidence: string };
  /** Why the state is uncertain and the last evidence time (#873). Optional. */
  readonly diagnostic?: { readonly reason: string; readonly quiet_since?: string };
}

// lineage.v1 and work.v1 record members (session-board-v1 "Extensions").
export const BOARD_EXTENSIONS = ["lineage.v1", "work.v1"] as const;

/** A session identity; board references never carry an incarnation. */
export interface BoardSessionRef {
  readonly machine: string;
  readonly session_id: string;
  readonly session_created_at: string;
}

export interface BoardLineage {
  readonly parent: BoardSessionRef | null;
  readonly effective_parent: BoardSessionRef | null;
  readonly root: BoardSessionRef;
  readonly depth: number;
  readonly starter: { readonly kind: string; readonly via: string };
  readonly budget: Readonly<Record<string, number | null>> | null;
}

export interface BoardWorkRef {
  readonly provider: string;
  readonly repository: string;
  readonly number: number;
}

export interface BoardWork {
  readonly program: BoardWorkRef | null;
  readonly issues: readonly BoardWorkRef[];
  readonly inherited: boolean;
}

export interface BoardRecord {
  readonly machine: string;
  readonly session_id: string;
  readonly session_incarnation: string | null;
  readonly messaging_supported: boolean;
  readonly repo_name: string | null;
  readonly cwd: string | null;
  readonly provider: string;
  readonly agent_profile: string | null;
  readonly model?: string | null;
  readonly reasoning_effort?: string | null;
  readonly title: string | null;
  readonly title_state: { readonly activity: string | null } | null;
  readonly turn_state: BoardTurnState | null;
  readonly state: BoardState;
  readonly runtime_status: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly closed_at: string | null;
  readonly close_reason: BoardCloseReason | null;
  readonly summary: null;
  readonly role: SessionRole | null;
  readonly lineage: BoardLineage | null;
  readonly work: BoardWork | null;
}

/** A stored record from before lineage.v1 is served with null members. */
export function withBoardExtensionDefaults(record: BoardRecord): BoardRecord {
  return { ...record, ...normalizeSessionModelSettings(record), role: record.role ?? null, lineage: record.lineage ?? null, work: record.work ?? null };
}

const MAX_ID = 256;
const MAX_NAME = 512;
const MAX_TEXT = 4096;
const MAX_CODE = 64;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const INVALID = Symbol("invalid");
type Checked<T> = T | typeof INVALID;

function str(value: unknown, max: number, singleLine = true): Checked<string> {
  return typeof value === "string" && value.length > 0 && value.length <= max
    && (!singleLine || !CONTROL.test(value)) ? value : INVALID;
}

function nullableStr(value: unknown, max: number, singleLine = true): Checked<string | null> {
  return value === null ? null : str(value, max, singleLine);
}

export function boardTimestampMs(value: unknown): number | null {
  if (typeof value !== "string" || value.length > 64 || !TIMESTAMP.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function time(value: unknown): Checked<string> {
  return boardTimestampMs(value) === null ? INVALID : value as string;
}

function nullableTime(value: unknown): Checked<string | null> {
  return value === null ? null : time(value);
}

function turnState(value: unknown): Checked<BoardTurnState | null> {
  if (value === null) return null;
  const raw = object(value);
  if (!raw) return INVALID;
  const phase = str(raw.phase, MAX_CODE);
  const phaseChangedAt = time(raw.phase_changed_at);
  const confidence = str(object(raw.source)?.confidence, MAX_CODE);
  if (phase === INVALID || phaseChangedAt === INVALID || confidence === INVALID) return INVALID;
  let currentTurn: BoardTurnState["current_turn"] = null;
  if (raw.current_turn !== null && raw.current_turn !== undefined) {
    const current = object(raw.current_turn);
    if (!current) return INVALID;
    const lastProgressAt = nullableTime(current.last_progress_at ?? null);
    let attention: NonNullable<BoardTurnState["current_turn"]>["attention"] = null;
    if (current.attention !== null && current.attention !== undefined) {
      const rawAttention = object(current.attention);
      const kind = str(rawAttention?.kind, MAX_CODE);
      const requestedAt = nullableTime(rawAttention?.requested_at ?? null);
      if (kind === INVALID || requestedAt === INVALID) return INVALID;
      // Optional detail is kept only when well formed; otherwise it is dropped.
      const pending = rawAttention?.pending_count, certainty = rawAttention?.certainty;
      attention = { kind, requested_at: requestedAt,
        ...(Number.isSafeInteger(pending) && Number(pending) >= 0 ? { pending_count: Number(pending) } : {}),
        ...(certainty === "exact" || certainty === "conservative" ? { certainty } : {}) };
    }
    if (lastProgressAt === INVALID) return INVALID;
    currentTurn = { last_progress_at: lastProgressAt, attention };
  }
  let lastTurn: BoardTurnState["last_turn"] = null;
  if (raw.last_turn !== null && raw.last_turn !== undefined) {
    const last = object(raw.last_turn);
    const outcome = nullableStr(last?.outcome ?? null, MAX_CODE);
    if (!last || outcome === INVALID) return INVALID;
    lastTurn = { outcome };
  }
  const rawDiagnostic = object(raw.diagnostic);
  const reason = rawDiagnostic ? str(rawDiagnostic.reason, MAX_CODE) : INVALID;
  const quietSince = rawDiagnostic?.quiet_since === undefined ? undefined : time(rawDiagnostic.quiet_since);
  return {
    phase,
    phase_changed_at: phaseChangedAt,
    current_turn: currentTurn,
    last_turn: lastTurn,
    source: { confidence },
    ...(reason === INVALID ? {} : { diagnostic: { reason, ...(quietSince === undefined || quietSince === INVALID ? {} : { quiet_since: quietSince }) } }),
  };
}

const MAX_DEPTH = 64;
const MAX_ISSUES = 16;
const MAX_BUDGET_KEYS = 16;

function sessionRef(value: unknown): Checked<BoardSessionRef> {
  const raw = object(value);
  const machine = str(raw?.machine, MAX_NAME);
  const sessionId = str(raw?.session_id, MAX_ID);
  const createdAt = time(raw?.session_created_at);
  if (machine === INVALID || sessionId === INVALID || createdAt === INVALID) return INVALID;
  return { machine, session_id: sessionId, session_created_at: createdAt };
}

function nullableSessionRef(value: unknown): Checked<BoardSessionRef | null> {
  return value === null ? null : sessionRef(value);
}

// The reserved subtree budget is kept only as a small map of numbers.
function budget(value: unknown): Checked<BoardLineage["budget"]> {
  if (value === null || value === undefined) return null;
  const raw = object(value);
  if (!raw) return INVALID;
  const entries = Object.entries(raw);
  if (entries.length > MAX_BUDGET_KEYS) return INVALID;
  const out: Record<string, number | null> = {};
  for (const [key, item] of entries) {
    if (str(key, MAX_CODE) === INVALID || !(item === null || (typeof item === "number" && Number.isFinite(item)))) return INVALID;
    out[key] = item;
  }
  return out;
}

function lineage(value: unknown): Checked<BoardLineage | null> {
  if (value === null || value === undefined) return null;
  const raw = object(value);
  if (!raw) return INVALID;
  const parent = nullableSessionRef(raw.parent);
  const effectiveParent = nullableSessionRef(raw.effective_parent);
  const root = sessionRef(raw.root);
  const starter = object(raw.starter);
  const kind = str(starter?.kind, MAX_CODE);
  const via = str(starter?.via, MAX_CODE);
  const reserved = budget(raw.budget);
  const depth = raw.depth;
  if (
    parent === INVALID || effectiveParent === INVALID || root === INVALID || kind === INVALID || via === INVALID
    || reserved === INVALID || !Number.isSafeInteger(depth) || (depth as number) < 0 || (depth as number) > MAX_DEPTH
  ) return INVALID;
  return { parent, effective_parent: effectiveParent, root, depth: depth as number, starter: { kind, via }, budget: reserved };
}

function workRef(value: unknown): Checked<BoardWorkRef> {
  const raw = object(value);
  const provider = str(raw?.provider, MAX_CODE);
  const repository = str(raw?.repository, MAX_NAME);
  const number = raw?.number;
  if (provider === INVALID || repository === INVALID || !Number.isSafeInteger(number) || (number as number) <= 0) return INVALID;
  return { provider, repository, number: number as number };
}

function work(value: unknown): Checked<BoardWork | null> {
  if (value === null || value === undefined) return null;
  const raw = object(value);
  if (!raw || !Array.isArray(raw.issues) || raw.issues.length > MAX_ISSUES || typeof raw.inherited !== "boolean") return INVALID;
  const program = raw.program === null || raw.program === undefined ? null : workRef(raw.program);
  const issues = raw.issues.map(workRef);
  if (program === INVALID || issues.some((issue) => issue === INVALID)) return INVALID;
  return { program, issues: issues as BoardWorkRef[], inherited: raw.inherited };
}

const CLOSED_REASONS_FROM_DAEMON = new Set(["deleted", "archived", "exited"]);

/**
 * Validates one daemon record and re-projects it to the v1 field allowlist.
 * `kind` selects the snapshot (`live`/`stopped`) or closed-ledger contract.
 * Returns null for any contract violation. The caller checks `machine` first:
 * a record naming another machine rejects the whole response.
 */
export function projectBoardRecord(
  value: unknown,
  machine: string,
  kind: "snapshot" | "closed",
): BoardRecord | null {
  const raw = object(value);
  if (!raw || raw.machine !== machine) return null;
  const sessionId = str(raw.session_id, MAX_ID);
  const incarnation = nullableStr(raw.session_incarnation, MAX_ID);
  // Display text is untrusted peer data rendered as text; the spec types it
  // only as string or null, so control characters are kept, not rejected.
  const repoName = nullableStr(raw.repo_name, MAX_TEXT, false);
  const cwd = nullableStr(raw.cwd, MAX_TEXT, false);
  const provider = str(raw.provider, MAX_CODE);
  const agentProfile = nullableStr(raw.agent_profile, MAX_NAME);
  const title = nullableStr(raw.title, MAX_TEXT, false);
  const createdAt = time(raw.created_at);
  const updatedAt = time(raw.updated_at);
  const turn = turnState(raw.turn_state);
  // lineage.v1 / work.v1: absent from a daemon that predates them, so null.
  const role = normalizeSessionRole(raw.role) ?? null;
  const recordLineage = lineage(raw.lineage);
  const recordWork = work(raw.work);
  let titleState: Checked<BoardRecord["title_state"]> = null;
  if (raw.title_state !== null) {
    const rawTitleState = object(raw.title_state);
    const activity = nullableStr(rawTitleState?.activity ?? null, MAX_TEXT, false);
    titleState = rawTitleState && activity !== INVALID ? { activity } : INVALID;
  }
  if (
    sessionId === INVALID || incarnation === INVALID || repoName === INVALID || cwd === INVALID
    || provider === INVALID || agentProfile === INVALID || title === INVALID
    || createdAt === INVALID || updatedAt === INVALID || turn === INVALID || titleState === INVALID
    || recordLineage === INVALID || recordWork === INVALID
    || typeof raw.messaging_supported !== "boolean"
    || (raw.summary !== null && typeof raw.summary !== "string")
  ) return null;
  const common = {
    machine,
    session_id: sessionId,
    session_incarnation: incarnation,
    repo_name: repoName,
    cwd,
    provider,
    agent_profile: agentProfile,
    ...normalizeSessionModelSettings(raw),
    title,
    title_state: titleState,
    turn_state: turn,
    created_at: createdAt,
    updated_at: updatedAt,
    // Reserved in v1: consumers must not depend on it, so it is never stored.
    summary: null,
    role,
    lineage: recordLineage,
    work: recordWork,
  } as const;
  if (kind === "snapshot") {
    const runtimeStatus = nullableStr(raw.runtime_status, MAX_CODE);
    if (
      (raw.state !== "live" && raw.state !== "stopped") || runtimeStatus === INVALID
      || raw.closed_at !== null || raw.close_reason !== null
    ) return null;
    return {
      ...common,
      messaging_supported: raw.messaging_supported,
      state: raw.state,
      runtime_status: runtimeStatus,
      closed_at: null,
      close_reason: null,
    };
  }
  const closedAt = time(raw.closed_at);
  if (
    raw.state !== "closed" || closedAt === INVALID
    || typeof raw.close_reason !== "string" || !CLOSED_REASONS_FROM_DAEMON.has(raw.close_reason)
  ) return null;
  return {
    ...common,
    messaging_supported: false,
    state: "closed",
    runtime_status: null,
    closed_at: closedAt,
    close_reason: raw.close_reason as BoardCloseReason,
  };
}
