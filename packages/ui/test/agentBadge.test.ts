import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import type { ComponentType } from "react";
import { createUiSsrHarness, renderComponent } from "./support/ssr.ts";

// Imported rather than re-declared: a locally narrowed literal drifted from the
// component once already and made the widened prop inexpressible here.
interface AgentBadgeProps {
  readonly agent: string;
}

const ssr = createUiSsrHarness();

async function loadAgentBadge(): Promise<ComponentType<AgentBadgeProps>> {
  const module = await ssr.loadModule<{ AgentBadge: ComponentType<AgentBadgeProps> }>("/src/AgentBadge.tsx");
  return module.AgentBadge as ComponentType<AgentBadgeProps>;
}

function renderAgentBadge(AgentBadge: ComponentType<AgentBadgeProps>, agent: string): string {
  return renderComponent(AgentBadge, { agent });
}

after(async () => {
  await ssr.close();
});

test("AgentBadge renders provider icons with accessible labels", async () => {
  const AgentBadge = await loadAgentBadge();

  const codex = renderAgentBadge(AgentBadge, "codex");
  assert.match(codex, /class="agent-badge codex"/);
  assert.match(codex, /role="img"/);
  assert.match(codex, /aria-label="Codex"/);
  assert.match(codex, /title="Codex"/);
  assert.match(codex, /class="agent-badge-icon openai-mark"/);
  assert.doesNotMatch(codex, /agent-badge-fallback/);

  const claude = renderAgentBadge(AgentBadge, "claude");
  assert.match(claude, /class="agent-badge claude"/);
  assert.match(claude, /aria-label="Claude"/);
  assert.match(claude, /title="Claude"/);
  assert.match(claude, /class="agent-badge-icon claude-mark"/);
  assert.doesNotMatch(claude, /agent-badge-fallback/);

  const dsh = renderAgentBadge(AgentBadge, "dsh");
  assert.match(dsh, /class="agent-badge dsh"/);
  assert.match(dsh, /aria-label="DSH"/);
  assert.match(dsh, /title="DSH"/);
  assert.match(dsh, /class="agent-badge-icon dsh-mark"/);
  assert.doesNotMatch(dsh, /agent-badge-fallback/);
});

test("AgentBadge renders fallback labels for non-icon providers", async () => {
  const AgentBadge = await loadAgentBadge();

  const unknown = renderAgentBadge(AgentBadge, "other provider!");
  assert.match(unknown, /class="agent-badge otherprovider"/);
  assert.match(unknown, /aria-label="other provider!"/);
  assert.match(unknown, /title="other provider!"/);
  assert.match(unknown, /class="agent-badge-fallback" aria-hidden="true">O<\/span>/);

  const blank = renderAgentBadge(AgentBadge, "");
  assert.match(blank, /class="agent-badge unknown"/);
  assert.match(blank, /aria-label="Unknown agent"/);
  assert.match(blank, /title="Unknown agent"/);
  assert.match(blank, /class="agent-badge-fallback" aria-hidden="true">\?<\/span>/);
});

test("AgentBadge no longer carries a mark for the retired hermes kind", async () => {
  const AgentBadge = await loadAgentBadge();

  const hermes = renderAgentBadge(AgentBadge, "hermes");
  assert.match(hermes, /class="agent-badge hermes"/);
  assert.match(hermes, /class="agent-badge-fallback" aria-hidden="true">H<\/span>/);
  // The retired hermes base no longer renders as DSH.
  assert.doesNotMatch(hermes, /hermes-mark|dsh-mark|aria-label="DSH"/);
});
