import { strict as assert } from "node:assert";
import { test } from "node:test";
import { formatContextUsage, normalizeContextUsage, type ContextUsage } from "../src/contextUsage.ts";

test("context usage renders compact counts, rounded percent, and a source tooltip", () => {
  const usage = normalizeContextUsage({
    used_tokens: 244000,
    window_tokens: 1000000,
    source: "codex-rollout",
    observed_at: "2026-10-14T00:00:00Z",
    model: "gpt-example",
  });
  assert.deepEqual(formatContextUsage(usage, 0), {
    text: "· 24% 244k/1M",
    percentText: "24%",
    tokensText: "244k/1M",
    title: "Context usage: 244,000 / 1,000,000 tokens · codex-rollout · 2026-10-14T00:00:00Z · gpt-example",
    stale: false,
  });
});

test("context usage rounds counts below ten thousand to whole k, half up", () => {
  const format = (used_tokens: number, window_tokens: number) => formatContextUsage({
    used_tokens, window_tokens, source: "codex-rollout", observed_at: null, model: null,
  }, 0)?.text;
  assert.equal(format(9_500, 1_000_000), "· 1% 10k/1M");
  assert.equal(format(1_200, 1_000_000), "· 0% 1k/1M");
  assert.equal(format(9_499, 1_000_000), "· 1% 9k/1M");
  assert.equal(format(10_500, 1_000_000), "· 1% 11k/1M");
  assert.equal(format(1_250_000, 2_000_000), "· 63% 1.3M/2M");
});

test("unknown or invalid context usage is hidden without a fake zero", () => {
  assert.equal(normalizeContextUsage(undefined), undefined);
  assert.equal(normalizeContextUsage(null), undefined);
  assert.equal(normalizeContextUsage({ used_tokens: 0, window_tokens: 0, source: "codex-rollout", observed_at: "2026-10-14T00:00:00Z" }), undefined);
  const missingWindow = normalizeContextUsage({ used_tokens: 130, window_tokens: null, source: "claude-transcript", observed_at: null, model: null });
  assert.equal(formatContextUsage(missingWindow, 0), undefined);
  assert.equal(formatContextUsage(undefined, 0), undefined);
});

test("working sessions mark context usage older than ten minutes stale", () => {
  const usage: ContextUsage = {
    used_tokens: 50,
    window_tokens: 100,
    source: "claude-transcript",
    observed_at: "2026-10-14T00:00:00Z",
    model: "claude-example",
  };
  assert.equal(formatContextUsage(usage, Date.parse("2026-10-14T00:10:01Z"), true)?.stale, true);
  assert.equal(formatContextUsage(usage, Date.parse("2026-10-14T00:10:01Z"), false)?.stale, false);
});
