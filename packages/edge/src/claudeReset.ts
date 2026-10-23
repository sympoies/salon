// Claude limit resets: the status a usage reader reports per Claude account and
// the redeem request the edge forwards to `agent-session serve`. The upstream
// API is undocumented, so every read degrades to "unknown" (null) instead of
// failing the usage card, and only allowlisted, bounded fields cross the edge.
import {
  CLAUDE_LIMIT_RESET_OUTCOMES,
  CLAUDE_LIMIT_RESET_PROGRAMS,
  CLAUDE_LIMIT_RESET_SCHEMA_VERSION,
  normalizeAccountNickname,
  type ClaudeGrantedResets,
  type ClaudeLimitResetOutcome,
  type ClaudeLimitResetProgram,
  type ClaudeLimitResetResult,
  type ClaudeLimitResets,
  type ClaudeResetGrant,
  type ClaudeSessionReset,
} from "@agent-console/shared/api";
import { withHostReaderJson, type HostReader } from "./hostReader.ts";
import { asString, objectProp } from "./normalize.ts";
import { normalizeCodexResetIdempotencyKey } from "./codexReset.ts";

const MAX_RESPONSE_BYTES = 64 * 1024;
// serve answers only once `claude-cli` has read status and posted (its kill
// deadline is 35 seconds), so the shared 8-second reader timeout would report
// a failure for a reset that landed.
const RESET_TIMEOUT_MS = 45_000;
// `agent-session serve` is the only Claude reset controller; the path is
// configurable like the Codex one (AGENT_CONSOLE_CLAUDE_RESET_PATH).
const DEFAULT_RESET_PATH = "/claude/reset/v1";
const MAX_GRANTS = 16;
const MAX_CLEARS = 8;
const MAX_LABEL_LENGTH = 80;
const TOKEN_PATTERN = /^[a-z0-9_]{1,40}$/;
const PROGRAMS = new Set<string>(CLAUDE_LIMIT_RESET_PROGRAMS);
const OUTCOMES = new Set<string>(CLAUDE_LIMIT_RESET_OUTCOMES);

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// A bounded upstream token (`not_at_wall`, `tenure`, ...); anything else that is
// present becomes `unknown` so free text never reaches the UI.
function reason(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === "string" && TOKEN_PATTERN.test(value) ? value : "unknown";
}

// Epoch seconds from epoch seconds/milliseconds or an ISO-8601 string.
function epoch(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value > 1_000_000_000_000 ? value / 1000 : value);
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000);
}

function sessionReset(value: unknown): ClaudeSessionReset | null {
  const raw = objectProp(value);
  if (!raw || typeof raw.available !== "boolean") return null;
  return {
    available: raw.available,
    ineligible_reason: reason(raw.ineligible_reason),
    resets_per_week: count(raw.resets_per_week),
    next_available_at: epoch(raw.next_available_at),
    weekly_resets_at: epoch(raw.weekly_resets_at),
  };
}

function grant(value: unknown): ClaudeResetGrant | null {
  const raw = objectProp(value);
  const resetsLeft = count(raw?.resets_left);
  if (!raw || resetsLeft === null) return null;
  const clears = Array.isArray(raw.clears)
    ? raw.clears.filter((limit): limit is string => typeof limit === "string" && TOKEN_PATTERN.test(limit)).slice(0, MAX_CLEARS)
    : [];
  return {
    label: asString(raw.label)?.trim().slice(0, MAX_LABEL_LENGTH) || null,
    resets_left: resetsLeft,
    resets_total: count(raw.resets_total),
    starts_at: epoch(raw.starts_at),
    expires_at: epoch(raw.expires_at) ?? epoch(raw.ends_at),
    clears,
    usable_now: raw.usable_now === true,
  };
}

function grantedResets(value: unknown): ClaudeGrantedResets | null {
  const raw = objectProp(value);
  if (!raw || typeof raw.available !== "boolean") return null;
  const grants: ClaudeResetGrant[] = [];
  for (const entry of Array.isArray(raw.grants) ? raw.grants : []) {
    const normalized = grant(entry);
    if (normalized) grants.push(normalized);
    if (grants.length === MAX_GRANTS) break;
  }
  return {
    available: raw.available,
    ineligible_reason: reason(raw.ineligible_reason),
    grants,
    cooldown_until: epoch(raw.cooldown_until),
    weekly_resets_at: epoch(raw.weekly_resets_at),
  };
}

// A reader's `limit_resets` block; null when it is not an object. Each program
// is normalized on its own, so one malformed program leaves the other intact.
export function normalizeClaudeLimitResets(value: unknown): ClaudeLimitResets | null {
  const raw = objectProp(value);
  if (!raw) return null;
  return {
    juniper_tide: sessionReset(raw.juniper_tide),
    cedar_ember: grantedResets(raw.cedar_ember),
  };
}

export function normalizeClaudeResetProgram(value: unknown): ClaudeLimitResetProgram | null {
  return typeof value === "string" && PROGRAMS.has(value) ? value as ClaudeLimitResetProgram : null;
}

export interface ClaudeResetRequest {
  readonly account: string;
  readonly program: ClaudeLimitResetProgram;
  readonly idempotency_key: string;
}

// The exact request body: a token-authority profile nickname, one program, and
// a canonical UUID. Grant ids never come from the client; the host picks the
// grant from its own fresh status read.
export function normalizeClaudeResetRequest(value: unknown): ClaudeResetRequest | null {
  const body = objectProp(value);
  if (!body || Object.keys(body).some((key) => key !== "account" && key !== "program" && key !== "idempotency_key")) {
    return null;
  }
  const account = normalizeAccountNickname(body.account);
  const program = normalizeClaudeResetProgram(body.program);
  const idempotencyKey = normalizeCodexResetIdempotencyKey(body.idempotency_key);
  return account && program && idempotencyKey ? { account, program, idempotency_key: idempotencyKey } : null;
}

export function normalizeClaudeResetResult(value: unknown): ClaudeLimitResetResult | null {
  const root = objectProp(value);
  const program = normalizeClaudeResetProgram(root?.program);
  const outcome = asString(root?.outcome);
  if (root?.schema_version !== CLAUDE_LIMIT_RESET_SCHEMA_VERSION || !program || !outcome || !OUTCOMES.has(outcome)) {
    return null;
  }
  const resetsLeft = count(root.resets_left);
  if (root.resets_left !== undefined && root.resets_left !== null && resetsLeft === null) return null;
  return {
    schema_version: CLAUDE_LIMIT_RESET_SCHEMA_VERSION,
    program,
    outcome: outcome as ClaudeLimitResetOutcome,
    reason: reason(root.reason),
    resets_left: resetsLeft,
    next_available_at: epoch(root.next_available_at),
    cooldown_until: epoch(root.cooldown_until),
    weekly_resets_at: epoch(root.weekly_resets_at),
  };
}

export async function resetClaudeLimit(
  reader: HostReader,
  request: ClaudeResetRequest,
): Promise<ClaudeLimitResetResult> {
  return withHostReaderJson(
    reader,
    reader.path ?? DEFAULT_RESET_PATH,
    (body) => {
      const result = normalizeClaudeResetResult(body);
      if (!result) throw new Error("Claude reset controller returned an invalid result");
      return result;
    },
    {
      method: "POST",
      jsonBody: JSON.stringify(request),
      timeoutMs: RESET_TIMEOUT_MS,
      maxBytes: MAX_RESPONSE_BYTES,
      statusLabel: "Claude reset controller status",
      sizeErrorMessage: "Claude reset controller response too large",
      redirect: "error",
    },
  );
}
