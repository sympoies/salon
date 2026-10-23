/** Display metadata supplied by the session runtime; never derive it from accounts. */
export interface SessionModelSettings {
  readonly model?: string | null;
  readonly reasoning_effort?: string | null;
}

const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "auto"]);
const CREDENTIAL_PREFIX = /^(sk-|sk_live_|sk_test_|pk_live_|rk_live_|gh[pousr]_|github_pat_|glpat-|hf_|xox[bpars]-|eyj|npm_|pypi-|akia|aiza)/i;

const BOT_CREDENTIAL = /^\d{6,}:[a-z0-9_-]{20,}$/i;

export function normalizeSessionModelSettings(value: unknown): Required<SessionModelSettings> {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const model = typeof raw.model === "string"
    && raw.model.length <= 128
    // Every namespace component starts with an alphanumeric character, so
    // absolute paths, dot segments, empty segments, and URLs stay invalid.
    && /^[a-z0-9][a-z0-9_.:\[\]-]*(?:\/[a-z0-9][a-z0-9_.:\[\]-]*)*$/i.test(raw.model)
    && raw.model.split("/").every((part) => !CREDENTIAL_PREFIX.test(part) && !BOT_CREDENTIAL.test(part))
    ? raw.model : null;
  const effort = typeof raw.reasoning_effort === "string" && EFFORTS.has(raw.reasoning_effort)
    ? raw.reasoning_effort : null;
  return { model, reasoning_effort: effort };
}

export function sessionModelLabel(value: SessionModelSettings): string {
  const settings = normalizeSessionModelSettings(value);
  return `${settings.model ?? "unknown"} · ${settings.reasoning_effort ?? "unknown"}`;
}
