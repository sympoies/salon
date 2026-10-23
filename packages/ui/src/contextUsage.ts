import { normalizeAgentSessionContextUsage, type AgentSessionContextUsage } from "@agent-console/shared/api";

export type ContextUsage = AgentSessionContextUsage;

export function normalizeContextUsage(value: unknown): ContextUsage | undefined {
  return normalizeAgentSessionContextUsage(value) ?? undefined;
}

function compactTokens(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${Number(millions.toFixed(millions < 10 && !Number.isInteger(millions) ? 1 : 0))}M`;
  }
  if (value >= 1_000) {
    if (value < 10_000) return `${Math.floor(value / 1_000 + 0.5)}k`;
    const thousands = value / 1_000;
    return `${Number(thousands.toFixed(thousands < 10 && !Number.isInteger(thousands) ? 1 : 0))}k`;
  }
  return String(value);
}

export function formatContextUsage(
  usage: ContextUsage | null | undefined,
  nowMs = Date.now(),
  working = false,
): {
  readonly text: string;
  /** `text` split so a narrow row can drop the tokens and keep the percentage. */
  readonly percentText: string;
  readonly tokensText: string;
  readonly title: string;
  readonly stale: boolean;
} | undefined {
  if (
    !usage
    || !Number.isSafeInteger(usage.used_tokens) || usage.used_tokens === null || usage.used_tokens < 0
    || !Number.isSafeInteger(usage.window_tokens) || usage.window_tokens === null || usage.window_tokens <= 0
  ) return undefined;
  const percent = Math.round((usage.used_tokens / usage.window_tokens) * 100);
  const observedAt = usage.observed_at ? Date.parse(usage.observed_at) : Number.NaN;
  const stale = working && Number.isFinite(observedAt) && nowMs - observedAt > 10 * 60_000;
  const sourceDetail = usage.source ?? "unknown source";
  const observedDetail = usage.observed_at ?? "unknown time";
  const modelDetail = usage.model ? ` · ${usage.model}` : "";
  return {
    text: `· ${percent}% ${compactTokens(usage.used_tokens)}/${compactTokens(usage.window_tokens)}`,
    percentText: `${percent}%`,
    tokensText: `${compactTokens(usage.used_tokens)}/${compactTokens(usage.window_tokens)}`,
    title: `Context usage: ${usage.used_tokens.toLocaleString("en-US")} / ${usage.window_tokens.toLocaleString("en-US")} tokens · ${sourceDetail} · ${observedDetail}${modelDetail}`,
    stale,
  };
}
