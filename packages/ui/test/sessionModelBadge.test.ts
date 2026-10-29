import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import type { ComponentType } from "react";
import { Window } from "happy-dom";
import { sessionModelLabel, normalizeSessionModelSettings, type SessionModelSettings } from "@agent-console/shared/session-model";
import { createUiSsrHarness, renderComponent } from "./support/ssr.ts";
import { buildSessionActivityDetails, selectSessionActivity } from "../src/sessionActivity.ts";
import { makeSession } from "./support/fixtures.ts";

function badgeText(html: string): string | null {
  const window = new Window();
  window.document.body.innerHTML = html;
  return window.document.querySelector(".session-model-badge")?.textContent ?? null;
}

const ssr = createUiSsrHarness();
after(async () => ssr.close());

test("session model badge shows each provider and independent unknown values", async () => {
  const { SessionModelBadge } = await ssr.loadModule<{ SessionModelBadge: ComponentType<{ session: SessionModelSettings }> }>("/src/SessionModelBadge.tsx");
  for (const [agent, model, effort] of [["codex", "example-model", "medium"], ["claude", "opus", "medium"], ["other-provider", "local-model", null]] as const) {
    const session = makeSession({ agent, model, reasoning_effort: effort });
    const label = `${model} · ${effort ?? "unknown"}`;
    assert.equal(badgeText(renderComponent(SessionModelBadge, { session })), label);
    const input = { session, machineReachable: true, focused: false, nowMs: Date.now() };
    const rows = buildSessionActivityDetails({ ...input, effective: selectSessionActivity(input) }).flatMap((group) => group.rows);
    assert.equal(rows.find((row) => row.label === "Model")?.value, model);
    assert.equal(rows.find((row) => row.label === "Reasoning effort")?.value, effort ?? "unknown");
  }
  assert.equal(badgeText(renderComponent(SessionModelBadge, { session: {} })), "unknown · unknown");
  assert.equal(sessionModelLabel({ model: null, reasoning_effort: "low" }), "unknown · low");
});

test("session model normalization bounds labels and rejects private or malformed metadata", () => {
  for (const model of ["/private/model", "sk-secret-canary", "ghp_example", "gho_example", "ghu_example", "ghs_example", "ghr_example", "xoxp-example", "xoxa-example", "eyJexample.example.example", "x".repeat(129), "model\ntext", { secret: true }]) {
    assert.equal(normalizeSessionModelSettings({ model, reasoning_effort: "medium" }).model, null);
  }
  assert.equal(normalizeSessionModelSettings({ model: "local-model", reasoning_effort: "unsupported" }).reasoning_effort, null);
});

test("session model row appends usage as plain text and hides it when unknown", async () => {
  const { SessionModelBadge } = await ssr.loadModule<{ SessionModelBadge: ComponentType<{ session: SessionModelSettings }> }>("/src/SessionModelBadge.tsx");
  const session = makeSession({
    model: "gpt-example",
    reasoning_effort: "high",
    context_usage: {
      used_tokens: 244000,
      window_tokens: 1000000,
      source: "codex-rollout",
      observed_at: new Date().toISOString(),
      model: "gpt-example",
    },
  });
  const html = renderComponent(SessionModelBadge, { session });
  assert.equal(badgeText(html), "gpt-example · high · 24% 244k/1M");
  assert.match(html, /Context usage: 244,000 \/ 1,000,000 tokens · codex-rollout/);
  assert.ok(!renderComponent(SessionModelBadge, { session: makeSession({ context_usage: null }) }).includes("Context usage:"));
});

test("stale context usage stays visible but dims only its text while working", async () => {
  const { SessionModelBadge } = await ssr.loadModule<{ SessionModelBadge: ComponentType<{ session: SessionModelSettings }> }>("/src/SessionModelBadge.tsx");
  const now = Date.now();
  const session = makeSession({
    context_usage: {
      used_tokens: 50,
      window_tokens: 100,
      source: "codex-rollout",
      observed_at: new Date(now - 11 * 60_000).toISOString(),
    },
    turn_state: {
      schema_version: "agent-session.turn-state.v1",
      phase: "working",
      phase_changed_at: new Date(now).toISOString(),
      revision: 1,
      source: { kind: "runtime", confidence: "observed" },
    },
  });
  const html = renderComponent(SessionModelBadge, { session });
  assert.match(html, /<span data-context-usage="true" style="[^"]*opacity:0\.55[^"]*"><span data-context-sep="true"> · <\/span>50%<span data-context-tokens="true"> 50\/100<\/span><\/span>/);
});
