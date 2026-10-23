import {
  CODEX_RATE_LIMIT_RESET_SCHEMA_VERSION,
  normalizeAccountNickname,
  type CodexRateLimitResetOutcome,
  type CodexRateLimitResetResult,
} from "@agent-console/shared/api";
import { withHostReaderJson, type HostReader } from "./hostReader.ts";
import { asFiniteNumber, asString, objectProp } from "./normalize.ts";

const MAX_RESPONSE_BYTES = 64 * 1024;
// The host controller's route; `agent-session serve` uses `/codex/reset/v1`
// (configured through AGENT_CONSOLE_CODEX_RESET_PATH) and returns the same
// versioned document with extra fields that normalization drops.
const DEFAULT_RESET_PATH = "/reset";
const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OUTCOMES = new Set<CodexRateLimitResetOutcome>([
  "reset",
  "nothing_to_reset",
  "no_credit",
  "already_redeemed",
]);

export function normalizeCodexResetAccount(value: unknown): string | null {
  return normalizeAccountNickname(value);
}

export function normalizeCodexResetIdempotencyKey(value: unknown): string | null {
  const key = asString(value);
  return key && CANONICAL_UUID_PATTERN.test(key) ? key : null;
}

export function normalizeCodexResetResult(value: unknown): CodexRateLimitResetResult | null {
  const root = objectProp(value);
  const result = objectProp(root?.result) ?? root;
  const outcome = asString(result?.outcome);
  if (
    root?.schema_version !== CODEX_RATE_LIMIT_RESET_SCHEMA_VERSION
    || !outcome
    || !OUTCOMES.has(outcome as CodexRateLimitResetOutcome)
  ) {
    return null;
  }
  const rawWindowsReset = result?.windows_reset;
  const windowsReset = asFiniteNumber(rawWindowsReset);
  if (
    rawWindowsReset !== undefined
    && (!Number.isSafeInteger(windowsReset) || (windowsReset ?? -1) < 0)
  ) {
    return null;
  }
  return {
    schema_version: CODEX_RATE_LIMIT_RESET_SCHEMA_VERSION,
    outcome: outcome as CodexRateLimitResetOutcome,
    ...(windowsReset === null ? {} : { windows_reset: windowsReset }),
  };
}

export async function resetCodexRateLimit(
  reader: HostReader,
  account: string,
  idempotencyKey: string,
): Promise<CodexRateLimitResetResult> {
  return withHostReaderJson(
    reader,
    reader.path ?? DEFAULT_RESET_PATH,
    (body) => {
      const result = normalizeCodexResetResult(body);
      if (!result) throw new Error("Codex reset controller returned an invalid result");
      return result;
    },
    {
      method: "POST",
      jsonBody: JSON.stringify({ account, idempotency_key: idempotencyKey }),
      maxBytes: MAX_RESPONSE_BYTES,
      statusLabel: "Codex reset controller status",
      sizeErrorMessage: "Codex reset controller response too large",
      redirect: "error",
    },
  );
}
