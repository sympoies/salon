import { createBadgeSsrHarness as createUiSsrHarness } from "./support/neutralBadges.ts";
import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement, type ComponentType, type Context } from "react";
import { createRoot } from "react-dom/client";
import type { Plugin } from "vite";
import type { DashboardUsageSnapshot } from "../src/HeaderUsage.tsx";
import type { SessionSlotProps } from "../src/SessionSlot.tsx";
import type { ProviderUsage } from "../src/api.ts";
import { BASE_TERMINAL_FONT_SIZE } from "../src/terminalFit.ts";
import type { Session } from "../src/types.ts";
import { assertActiveElement, assertNoElement } from "./support/domAssert.ts";
import { makeSession, makeSessionSlotProps } from "./support/fixtures.ts";
import { makeCssRuleLookup, uiSource, uiStyles } from "./support/source.ts";
import { renderComponent } from "./support/ssr.ts";

const cssRuleFor = makeCssRuleLookup(uiStyles());

type SessionSlotComponent = ComponentType<SessionSlotProps>;

const ssr = createUiSsrHarness([mockTerminalPanePlugin()]);

function mockTerminalPanePlugin(): Plugin {
  const mockId = "\0terminal-pane-mock";
  return {
    name: "mock-terminal-pane",
    enforce: "pre",
    resolveId(source, importer) {
      if (source.endsWith("TerminalPane.tsx") && importer?.includes("/src/")) {
        return mockId;
      }
      return null;
    },
    load(id) {
      if (id !== mockId) {
        return null;
      }
      return `
        import React from "react";
        export function TerminalPane(props) {
          return React.createElement("div", {
            className: "terminal-pane-mock",
            "data-font-size": String(props.fontSize),
            "data-readable-fit": String(props.readableFit),
            "data-machine-reachable": String(props.machineReachable),
          });
        }
      `;
    },
  };
}

async function loadSessionSlot(): Promise<SessionSlotComponent> {
  const module = await ssr.loadModule<{ SessionSlot: SessionSlotComponent }>("/src/SessionSlot.tsx");
  return module.SessionSlot as SessionSlotComponent;
}

async function loadDashboardUsageContext(): Promise<Context<DashboardUsageSnapshot>> {
  const module = await ssr.loadModule<{
    DashboardUsageContext: Context<DashboardUsageSnapshot>;
  }>("/src/HeaderUsage.tsx");
  return module.DashboardUsageContext;
}

function renderSlot(SessionSlot: SessionSlotComponent, activeSession: Session): string {
  return renderComponent(SessionSlot, makeSessionSlotProps({ session: activeSession, options: [activeSession] }));
}

function providerUsage(account: string, windows: ProviderUsage["windows"] = []): ProviderUsage {
  return {
    provider: "codex",
    account,
    label: "Codex",
    ok: true,
    stale: false,
    plan: account === "sym" ? "pro" : "team",
    windows,
    updated_at: Math.floor(Date.parse("2026-07-06T00:00:30Z") / 1000),
    note: null,
    error: null,
    reason_code: null,
  };
}

after(async () => {
  await ssr.close();
});

test("SessionSlot shows the managed copy command without provider resume metadata", async () => {
  const SessionSlot = await loadSessionSlot();
  const html = renderSlot(
    SessionSlot,
    makeSession({
      agent: "codex",
      title: "Codex session",
      managed_resume_command_available: true,
      attach_command: "tmux attach -t hs-codex-1",
      ssh_attach_command: "ssh -t summit 'tmux attach -t hs-codex-1'",
    }),
  );

  assert.match(html, /Copy session command/);
  assert.match(html, /session-command-copy-button/);
});

test("SessionSlot hides an unsafe copy action when no resume capability or metadata exists", async () => {
  const SessionSlot = await loadSessionSlot();
  const html = renderSlot(SessionSlot, makeSession({ agent: "codex", title: "Legacy Codex session" }));

  assert.doesNotMatch(html, /Copy session command/);
  assert.doesNotMatch(html, /session-command-copy-button/);
});

test("SessionSlot presents a resumable stopped session as one recovery action", async () => {
  const SessionSlot = await loadSessionSlot();
  const session = makeSession({ status: "stopped", resumable: true });
  const html = renderSlot(SessionSlot, session);

  assert.match(html, new RegExp(`aria-label="Recover ${session.title}"`));
  assert.match(html, />Recover<\/button>/);
  assert.doesNotMatch(html, />Resume<\/button>/);
});

test("SessionSlot explains every blocked profile recovery reason without offering Recover", async () => {
  const SessionSlot = await loadSessionSlot();
  const cases = [
    [
      "agent-profile-unavailable",
      "Recovery unavailable: the launch profile is no longer ready.",
    ],
    [
      "agent-profile-metadata-unavailable",
      "Recovery unavailable: this session predates managed profile metadata.",
    ],
    [
      "agent-profile-context-mismatch",
      "Recovery unavailable: the launch profile configuration changed.",
    ],
  ] as const;

  for (const [reason, message] of cases) {
    const html = renderSlot(
      SessionSlot,
      makeSession({
        agent: "claude",
        agent_profile: "custom-claude",
        status: "stopped",
        resumable: false,
        resume_blocked_reason: reason,
      }),
    );

    assert.doesNotMatch(html, />Recover<\/button>/);
    assert.match(html, /<p class="hint" role="status">/);
    assert.ok(html.includes(message), `${reason} should render its actionable message`);
  }
});

test("SessionSlot renders an old-daemon dsh session with the generic unknown badge", async () => {
  const SessionSlot = await loadSessionSlot();
  const html = renderSlot(SessionSlot, makeSession({ agent: "dsh" }));
  assert.match(html, /agent-badge unknown/);
  assert.match(html, /agent-badge-fallback[^>]*>D<\/span>/);
  const { AgentBadge } = await ssr.loadModule<{ AgentBadge: ComponentType<{ agent: string }> }>("/src/AgentBadge.tsx");
  assert.match(renderComponent(AgentBadge, { agent: "dsh" }), /aria-label="dsh"/);
  assert.doesNotMatch(html, /DSH|dsh-mark|agent-badge dsh/);
  assert.match(renderSlot(SessionSlot, makeSession({ agent: "codex" })), /openai-mark/);
  assert.match(renderSlot(SessionSlot, makeSession({ agent: "claude" })), /claude-mark/);
});

test("SessionSlot renders the current repo badge as an open-repository link", async () => {
  const SessionSlot = await loadSessionSlot();
  const html = renderSlot(
    SessionSlot,
    makeSession({
      title: "Codex session",
      cwd: "/workspace/agent-console",
      repo_name: "agent-console",
    }),
  );

  assert.match(html, /role="link"/);
  assert.match(html, /aria-label="Open agent-console repository"/);
  assert.match(html, /title="Open agent-console repository"/);
});

test("SessionSlot renders honest terminal fallback activity in the header metadata", async () => {
  const SessionSlot = await loadSessionSlot();
  const html = renderSlot(
    SessionSlot,
    makeSession({
      created_at: "2026-07-06T00:00:00Z",
      updated_at: "2026-07-06T00:00:30Z",
      last_terminal_activity_at: "2026-07-06T00:00:20Z",
    }),
  );

  assert.match(html, /session-activity-trigger activity-quiet/);
  assert.match(html, /aria-label="Session activity: State unknown: provider status unavailable"/);
  assert.match(html, /<span class="session-activity-text"><\/span>/);
  assert.match(html, /aria-expanded="false"/);
});

test("SessionSlot renders an exact provider working state", async () => {
  const SessionSlot = await loadSessionSlot();
  const html = renderSlot(
    SessionSlot,
    makeSession({
      turn_state: {
        schema_version: "agent-session.turn-state.v1",
        phase: "working",
        phase_changed_at: "2026-07-06T00:00:30Z",
        revision: 3,
        source: { kind: "provider_hook", provider: "codex", confidence: "authoritative" },
        current_turn: { started_at: "2026-07-06T00:00:30Z" },
      },
    }),
  );

  assert.match(html, /session-activity-trigger activity-working/);
  assert.match(html, /aria-label="Session activity: Working 30s"/);
  assert.match(html, /<span class="session-activity-text">0m<\/span>/);
});

test("SessionSlot renders a successful completed turn as Done", async () => {
  const SessionSlot = await loadSessionSlot();
  const html = renderSlot(
    SessionSlot,
    makeSession({
      turn_state: {
        schema_version: "agent-session.turn-state.v1",
        phase: "waiting",
        phase_changed_at: "2026-07-06T00:00:30Z",
        revision: 4,
        source: { kind: "provider_hook", provider: "codex", confidence: "authoritative" },
        last_turn: { completed_at: "2026-07-06T00:00:30Z", outcome: "completed" },
      },
    }),
  );

  assert.match(html, /session-activity-trigger activity-completed/);
  assert.match(html, /aria-label="Session activity: Done 30s"/);
  assert.match(html, /<span class="session-activity-text">0m<\/span>/);
});

test("SessionSlot renders Working and input attention as separate accessible cues", async () => {
  const SessionSlot = await loadSessionSlot();
  const html = renderSlot(
    SessionSlot,
    makeSession({
      turn_state: {
        schema_version: "agent-session.turn-state.v1",
        phase: "needs_input",
        phase_changed_at: "2026-07-06T00:00:40Z",
        revision: 4,
        source: { kind: "provider_hook", provider: "claude", confidence: "observed" },
        current_turn: {
          started_at: "2026-07-06T00:00:30Z",
          last_progress_at: "2026-07-06T00:00:50Z",
          attention: {
            kind: "clarification",
            requested_at: "2026-07-06T00:00:40Z",
            pending_count: 2,
            certainty: "exact",
          },
        },
      },
    }),
  );

  assert.match(html, /session-activity-trigger activity-working-attention card-state-blocked/, "a pending request needs attention (#873)");
  assert.match(html, /aria-label="Session activity: Needs input: clarification requested; Working 30s; input requested 20s; 2 pending"/);
  assert.match(html, /<span class="session-activity-text">0m<\/span>/);
  assert.doesNotMatch(html, /class="session-activity-attention"/);
});

test("SessionSlot places the copy command in row one, before the status metadata in row two", async () => {
  const SessionSlot = await loadSessionSlot();
  const html = renderSlot(
    SessionSlot,
    makeSession({
      agent: "codex",
      title: "Codex session",
      provider_resume: { provider: "codex", session_id: "codex-provider-id" },
    }),
  );

  const rowTwoIndex = html.indexOf('class="slot-session-card-row-two"');
  const copyIndex = html.indexOf("session-command-copy-button");

  assert.notEqual(rowTwoIndex, -1);
  assert.notEqual(copyIndex, -1);
  assert.ok(copyIndex < rowTwoIndex, "copy is an action in row one");
  assert.ok(html.indexOf("slot-meta", rowTwoIndex) > rowTwoIndex, "status metadata is in row two");
});

test("desktop and phone headers keep identity/actions before ordered harness information", async () => {
  const SessionSlot = await loadSessionSlot();
  for (const mobile of [false, true]) {
    for (const agent of ["codex", "claude"] as const) {
      const activeSession = makeSession({
        agent, role: "reviewer", repo_name: "fixture-project", title: "Fixture session",
        session_incarnation: "launch-1", model: "example-model", reasoning_effort: "high",
        provider_resume: { provider: agent, session_id: "fixture-provider-id" },
        codex_account: { schema_version: "agent-session.codex-account.v1", supported: true,
          state: "bound", selected_account: "fixture-account", revision: 1, applied_runtime_id: "launch-1" },
        claude_account: { schema_version: "agent-session.claude-account.v1", supported: true,
          state: "bound", selected_account: "fixture-account", selection_source: "default_at_launch",
          revision: 1, applied_runtime_id: "launch-1" },
      });
      const html = renderComponent(SessionSlot, makeSessionSlotProps({
        session: activeSession, options: [activeSession], accounts: [{ account: "fixture-account" }],
        viewport: { mobile }, focused: mobile, clockActive: false,
      }));
      const window = new Window();
      try {
        window.document.body.innerHTML = html;
        const one = window.document.querySelector(mobile ? ".slot-focus-row-one" : ".slot-session-card-row-one");
        const two = window.document.querySelector(mobile ? ".slot-focus-row-two" : ".slot-session-card-row-two");
        assert.ok(one && two, `${agent} ${mobile ? "phone" : "desktop"} has both semantic rows`);
        const identity = [".repo-badge-link", ".fixture-marker", ".slot-title-menu", ".session-command-copy-button",
          ...(!mobile ? [".slot-open"] : []), ".slot-action.danger"];
        const harness = [".agent-retitle-button", ".account-usage-root", ".session-model-badge",
          ".auto-resume-status", ".session-activity-root"];
        for (const [row, selectors, excluded] of [[one, identity, harness], [two, harness, identity]] as const) {
          const elements = selectors.map(selector => {
            const element = row.querySelector(selector);
            assert.ok(element, `${selector} belongs to its semantic row`);
            return element;
          });
          for (let i = 1; i < elements.length; i++) {
            assert.ok(elements[i - 1]!.compareDocumentPosition(elements[i]!) & window.Node.DOCUMENT_POSITION_FOLLOWING,
              `${selectors[i - 1]} precedes ${selectors[i]}`);
          }
          for (const selector of excluded) assertNoElement(row, selector, `${selector} does not cross rows`);
        }
        assert.equal(one.querySelector(".fixture-marker")?.getAttribute("aria-label"), "Reviewer");
      } finally {
        await window.close();
      }
    }
  }
});

test("SessionSlot renders the provider badge as a retitle action", async () => {
  const SessionSlot = await loadSessionSlot();
  const html = renderSlot(
    SessionSlot,
    makeSession({
      agent: "codex",
      title: "Codex session",
    }),
  );

  assert.match(html, /class="[^"]*\bagent-retitle-button\b[^"]*"/);
  assert.match(html, /aria-label="Retitle Codex session"/);
  assert.match(html, /title="Retitle Codex session"/);
  assert.match(html, /<span class="agent-badge codex" aria-hidden="true"/);
  assert.doesNotMatch(html, /class="agent-badge codex" role="img"/);
});

test("SessionSlot renders a retired claude-gpt session as plain Claude", async () => {
  const SessionSlot = await loadSessionSlot();
  // A stopped session recorded before claude-gpt was dropped still carries the
  // profile id. With the mark gone it must fall back to its base agent rather
  // than to the unlabelled fallback initial.
  const html = renderSlot(
    SessionSlot,
    makeSession({
      agent: "claude",
      agent_profile: "claude-gpt",
      title: "Retired profile session",
    }),
  );

  assert.match(html, /class="agent-badge claude"/);
  assert.match(html, /class="agent-badge-icon claude-mark"/);
  assert.doesNotMatch(html, /agent-console-mark/);
  assert.doesNotMatch(html, /agent-badge-fallback/);
});

test("SessionSlot keeps the repo badge in the title row and moves the provider retitle badge to row two", async () => {
  const SessionSlot = await loadSessionSlot();
  const html = renderSlot(
    SessionSlot,
    makeSession({
      agent: "codex",
      title: "Tune repo badge",
      cwd: "/workspace/agent-console",
      repo_name: "agent-console",
    }),
  );

  const repoIndex = html.indexOf('class="repo-badge-link"');
  const retitleIndex = html.indexOf("agent-retitle-button");
  const titleIndex = html.indexOf('class="slot-title-label"');
  const rowTwoIndex = html.indexOf('class="slot-session-card-row-two"');

  for (const [name, index] of Object.entries({ repoIndex, retitleIndex, titleIndex, rowTwoIndex })) {
    assert.notEqual(index, -1, `missing ${name}`);
  }
  assert.ok(repoIndex < titleIndex, "repo badge precedes the title in row one");
  assert.ok(rowTwoIndex < retitleIndex, "the provider badge is in row two");
});

test("desktop session cards put status in row two with model metadata and no host chip", async () => {
  const SessionSlot = await loadSessionSlot();
  const html = renderSlot(SessionSlot, makeSession({
    machine: "moss",
    model: "example-model",
    reasoning_effort: "medium",
  }));
  const rowOneStart = html.indexOf('class="slot-session-card-row-one"');
  const rowTwoStart = html.indexOf('class="slot-session-card-row-two"');
  const rowOne = html.slice(rowOneStart, rowTwoStart);
  const rowTwo = html.slice(rowTwoStart);

  assert.notEqual(rowOneStart, -1);
  assert.ok(rowOneStart < rowTwoStart);
  assert.doesNotMatch(rowOne, /session-host-chip/);
  assert.doesNotMatch(html, /session-host-chip/);
  assert.doesNotMatch(rowOne, /session-activity-trigger/, "the status dot and elapsed belong to row two");
  assert.match(rowTwo, /session-activity-trigger/);
  assert.match(rowTwo, /example-model · medium/);
  assert.doesNotMatch(rowTwo, /ctx\s*\d+%/i);
});

test("card header row one lets the title ellipsize before the action buttons", () => {
  const cardRowCss = makeCssRuleLookup(`${uiStyles()}\n${uiSource("sessionCardRows.css")}`);
  assert.match(cardRowCss(".slot-session-card-row-one > button"), /flex:\s*none/, "actions keep their width");
  assert.match(cardRowCss(".slot-session-card-row-one .slot-title-row"), /min-width:\s*0/, "the title row may shrink");
  assert.match(cardRowCss(".slot-session-card-row-two > .agent-retitle-button"), /flex:\s*none/, "the provider icon keeps its width");
});

test("card header row one is repo, role, title and actions; row two is provider, account, model, auto resume and status", async () => {
  const SessionSlot = await loadSessionSlot();
  const session = makeSession({
    machine: "moss",
    agent: "codex",
    status: "running",
    repo_name: "control",
    coordinator_tree: { depth: 0 },
    model: "example-model",
    reasoning_effort: "medium",
    managed_resume_command_available: true,
    attach_command: "tmux attach -t hs-codex-1",
    codex_account: {
      schema_version: "agent-session.codex-account.v1",
      supported: true,
      state: "bound",
      selected_account: "account-a",
      revision: 1,
      applied_runtime_id: "launch-hs-1",
    },
  });
  const html = renderComponent(SessionSlot, makeSessionSlotProps({
    session,
    options: [session],
    accounts: [{ account: "account-a" }, { account: "account-b" }],
  } as never));
  const rowOneStart = html.indexOf('class="slot-session-card-row-one"');
  const rowTwoStart = html.indexOf('class="slot-session-card-row-two"');
  assert.notEqual(rowOneStart, -1, "row one renders");
  assert.ok(rowOneStart < rowTwoStart, "row one precedes row two");
  const rowOne = html.slice(rowOneStart, rowTwoStart);
  const rowTwo = html.slice(rowTwoStart);
  const order = (text: string, markers: readonly RegExp[], label: string) => {
    const positions = markers.map(marker => {
      const index = text.search(marker);
      assert.notEqual(index, -1, `${label} contains ${marker}`);
      return index;
    });
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b), `${label} order`);
  };
  order(rowOne, [/class="repo-badge/, /class="(?:[^"]* )?slot-title(?: [^"]*)?"/, /class="[^"]*session-command-copy-button/, /class="[^"]*slot-action slot-open"/, /class="[^"]*slot-action danger"/],
    "row one");
  order(rowTwo, [/class="[^"]*\bagent-retitle-button\b[^"]*"/, /class="[^"]*account-status/, /class="slot-meta session-model-badge"/, /class="[^"]*session-activity-trigger/],
    "row two");
  for (const moved of [/agent-retitle-button/, /account-status/, /session-model-badge/, /session-activity-trigger/]) {
    assert.doesNotMatch(rowOne, moved, `row one omits ${moved}`);
  }
});

test("desktop session cards omit the host chip while editing the title", async () => {
  const SessionSlot = await loadSessionSlot();
  const session = makeSession({ machine: "moss", model: "example-model" });
  const html = renderComponent(SessionSlot, makeSessionSlotProps({
    session,
    options: [session],
    editingTitleKey: "summit:hs-1",
  }));

  assert.match(html, /class="slot-title-edit"/);
  assert.doesNotMatch(html, /session-host-chip/);
});

test("open-session header omits the host chip", async () => {
  const SessionSlot = await loadSessionSlot();
  const session = makeSession({ machine: "moss", title: "Focused session" });
  const html = renderComponent(SessionSlot, makeSessionSlotProps({
    session,
    options: [session],
    focused: true,
    focusedKey: "summit:hs-1",
    sessionOrdinal: 1,
    sessionCount: 1,
  }));

  assert.match(html, /Focused session/);
  assert.doesNotMatch(html, /session-host-chip/);
});

test("SessionSlot uses configured machine accent color overrides", async () => {
  const SessionSlot = await loadSessionSlot();
  const activeSession = makeSession({ machine: "mesa" });
  const html = renderComponent(
    SessionSlot,
    makeSessionSlotProps({
      session: activeSession,
      options: [activeSession],
      machineColors: { mesa: "#addb67" },
    }),
  );

  assert.match(html, /style="[^"]*--machine-accent:#addb67/);
  assert.match(html, /style="[^"]*--machine-accent-rgb:173, 219, 103/);
});

test("SessionSlot renders copy command affordances for resumable running sessions", async () => {
  const SessionSlot = await loadSessionSlot();
  const html = renderSlot(
    SessionSlot,
    makeSession({
      agent: "codex",
      title: "Codex session",
      provider_resume: { provider: "codex", session_id: "codex-provider-id" },
    }),
  );

  assert.match(html, /Copy session command/);
  assert.match(html, /aria-label="Copy session command for Codex session"/);
  assert.match(html, /session-command-copy-button/);
});

test("SessionSlot places the Open icon action between copy and close", async () => {
  const SessionSlot = await loadSessionSlot();
  const html = renderSlot(
    SessionSlot,
    makeSession({
      agent: "codex",
      title: "Codex session",
      provider_resume: { provider: "codex", session_id: "codex-provider-id" },
    }),
  );

  const copyIndex = html.indexOf("session-command-copy-button");
  const openIndex = html.indexOf("slot-action slot-open");
  const closeIndex = html.indexOf("slot-action danger");

  for (const [name, index] of Object.entries({ copyIndex, openIndex, closeIndex })) {
    assert.notEqual(index, -1, `missing ${name}`);
  }
  assert.ok(copyIndex < openIndex);
  assert.ok(openIndex < closeIndex);
  assert.match(html, /aria-label="Open Codex session"/);
  assert.match(html, /title="Open session"/);
  assert.match(html, /class="open-session-icon"/);
  assert.doesNotMatch(html, />\s*Open\s*<\/button>/);
});

test("SessionSlot renders focused previous and next session controls around the ordinal", async () => {
  const SessionSlot = await loadSessionSlot();
  const activeSession = makeSession({ title: "Focused session" });
  const html = renderComponent(
    SessionSlot,
    makeSessionSlotProps({
      session: activeSession,
      options: [activeSession],
      focused: true,
      focusedKey: "summit:hs-1",
      sessionOrdinal: 2,
      sessionCount: 4,
    }),
  );

  assert.match(html, /aria-label="Previous session"/);
  assert.match(html, /aria-label="Session 2 of 4"/);
  assert.match(html, /2 \/ 4/);
  assert.match(html, /aria-label="Next session"/);
});

test("SessionSlot hides focused session navigation when there is only one session", async () => {
  const SessionSlot = await loadSessionSlot();
  const activeSession = makeSession({ title: "Only focused session" });
  const html = renderComponent(
    SessionSlot,
    makeSessionSlotProps({
      session: activeSession,
      options: [activeSession],
      focused: true,
      focusedKey: "summit:hs-1",
      sessionOrdinal: 1,
      sessionCount: 1,
    }),
  );

  assert.match(html, /aria-label="Back to session list"/);
  assert.doesNotMatch(html, /slot-session-nav/);
  assert.doesNotMatch(html, /aria-label="Session 1 of 1"/);
});

test("SessionSlot keeps mobile focused header focus order aligned with the visual rows", async () => {
  const SessionSlot = await loadSessionSlot();
  const activeSession = makeSession({
    agent: "codex",
    title: "Very long mobile focused session title",
    provider_resume: { provider: "codex", session_id: "codex-provider-id" },
  });
  const html = renderComponent(
    SessionSlot,
    makeSessionSlotProps({
      session: activeSession,
      options: [activeSession],
      focused: true,
      focusedKey: "summit:hs-1",
      sessionOrdinal: 2,
      sessionCount: 3,
      viewport: { mobile: true },
    }),
  );
  const desktopHtml = renderComponent(
    SessionSlot,
    makeSessionSlotProps({
      session: activeSession,
      options: [activeSession],
      focused: true,
      focusedKey: "summit:hs-1",
      sessionOrdinal: 2,
      sessionCount: 3,
      viewport: { mobile: false },
    }),
  );

  // Row one: Back, identity (repo, title) and fixed actions; row two: provider,
  // account, model, auto-resume, status and the pager.
  const toolbarIndex = html.indexOf("slot-focus-toolbar slot-focus-row-one");
  const backIndex = html.indexOf("slot-back", toolbarIndex);
  const rowIndex = html.indexOf("slot-title-row", backIndex);
  const repoIndex = html.indexOf("repo-badge-link", rowIndex);
  const titleIndex = html.indexOf("slot-title-menu", repoIndex);
  const labelIndex = html.indexOf("slot-title-label", titleIndex);
  const actionsIndex = html.indexOf("slot-focus-actions", labelIndex);
  const copyIndex = html.indexOf("session-command-copy-button", actionsIndex);
  const closeIndex = html.indexOf("slot-action danger", actionsIndex);
  const detailsIndex = html.indexOf("slot-session-details slot-focus-row-two");
  const retitleIndex = html.indexOf("agent-retitle-button", detailsIndex);
  const modelIndex = html.indexOf("session-model-badge", retitleIndex);
  const statusIndex = html.indexOf('class="slot-focus-status"', modelIndex);
  const autoResumeIndex = html.indexOf("auto-resume-status", statusIndex);
  const activityIndex = html.indexOf("session-activity-root", statusIndex);
  const navIndex = html.indexOf("slot-session-nav", activityIndex);

  for (const [name, index] of Object.entries({
    toolbarIndex,
    backIndex,
    rowIndex,
    repoIndex,
    titleIndex,
    labelIndex,
    actionsIndex,
    copyIndex,
    closeIndex,
    detailsIndex,
    retitleIndex,
    modelIndex,
    statusIndex,
    autoResumeIndex,
    activityIndex,
    navIndex,
  })) {
    assert.notEqual(index, -1, `missing ${name}`);
  }
  assert.match(html, /session-command-copy-button/);
  assert.match(desktopHtml, /session-command-copy-button/);
  assert.doesNotMatch(html, /slot-focus-statusbar/);
  assert.ok(copyIndex < closeIndex);
  assert.ok(closeIndex < detailsIndex);
  assert.ok(autoResumeIndex < activityIndex);
  assert.equal(html.lastIndexOf("agent-retitle-button"), retitleIndex, "the provider icon renders once, in row two");
  assert.match(
    cssRuleFor(
      ".session-workspace.mobile.is-focused .terminal-slot.is-focused .slot-focus-row-two .session-activity-text",
    ),
    /display: inline;/,
  );
});

test("SessionSlot forwards terminal display props to TerminalPane", async () => {
  const SessionSlot = await loadSessionSlot();
  const activeSession = makeSession({ title: "Terminal display" });
  const previewHtml = renderComponent(
    SessionSlot,
    makeSessionSlotProps({
      session: activeSession,
      options: [activeSession],
      focused: false,
      focusedKey: null,
      fontSize: BASE_TERMINAL_FONT_SIZE,
      terminalReadableFit: false,
    }),
  );
  const focusedHtml = renderComponent(
    SessionSlot,
    makeSessionSlotProps({
      session: activeSession,
      options: [activeSession],
      focused: true,
      focusedKey: "summit:hs-1",
      fontSize: BASE_TERMINAL_FONT_SIZE,
      terminalReadableFit: true,
    }),
  );

  assert.match(previewHtml, new RegExp(`data-font-size="${BASE_TERMINAL_FONT_SIZE}"`));
  assert.match(focusedHtml, new RegExp(`data-font-size="${BASE_TERMINAL_FONT_SIZE}"`));
  assert.match(previewHtml, /data-readable-fit="false"/);
  assert.match(focusedHtml, /data-readable-fit="true"/);
});

test("SessionSlot forwards machine reachability to TerminalPane for the recovery wake", async () => {
  const SessionSlot = await loadSessionSlot();
  const activeSession = makeSession({ title: "Recovery wake" });
  const render = (machineReachable: boolean) => renderComponent(
    SessionSlot,
    makeSessionSlotProps({ session: activeSession, options: [activeSession], machineReachable }),
  );

  assert.match(render(false), /data-machine-reachable="false"/);
  assert.match(render(true), /data-machine-reachable="true"/);
});

test("SessionSlot no longer duplicates copy command inside the slot menu dropdown", async () => {
  const SessionSlot = await loadSessionSlot();
  const html = renderSlot(
    SessionSlot,
    makeSession({
      agent: "codex",
      title: "Codex session",
      provider_resume: { provider: "codex", session_id: "codex-provider-id" },
    }),
  );

  // The dedicated button replaces the dropdown menu item. Isolate the title
  // menu region (everything up to its closing tag; the copy button is a sibling
  // rendered after it) so the guard catches any dropdown reintroduction
  // regardless of the wrapper markup used, not just the old slot-menu-label span.
  const menuHtml = html.slice(0, html.indexOf("</details>"));
  assert.match(menuHtml, /slot-title-dropdown/);
  assert.doesNotMatch(menuHtml, /Copy session command/);
  assert.match(html, /session-command-copy-button/);
});

test("SessionSlot renders accessible scheduled auto-resume status and cancellation", async () => {
  const SessionSlot = await loadSessionSlot();
  const session = makeSession({
    agent: "claude",
    auto_resume: {
      schema_version: "agent-session.auto-resume.v1",
      supported: true,
      enabled: true,
      state: "scheduled",
      scheduled_at: "2026-07-12T12:34:56Z",
    },
    auto_resume_control_available: true,
  });
  const html = renderComponent(SessionSlot, makeSessionSlotProps({
    session,
    options: [session],
    openSlotMenuKey: "slot-0",
    now: Date.parse("2026-07-12T12:30:00Z"),
  }));

  assert.match(html, /auto-resume-status-button/);
  assert.match(html, /Auto-resume scheduled in 5m/);
  assert.match(html, /aria-label="Cancel auto-resume for Test session"/);
  assert.match(html, /aria-describedby="[^"]+"/);
  assert.match(html, /class="sr-only"[^>]*>Auto-resume scheduled in 5m<\/span>/);
  assert.match(html, /role="status" aria-live="polite" aria-atomic="true"/);
});

test("SessionSlot keeps auto-resume control on the header badge instead of the title menu", async () => {
  const SessionSlot = await loadSessionSlot();
  const session = makeSession({
    agent: "claude",
    auto_resume: {
      schema_version: "agent-session.auto-resume.v1",
      supported: true,
      enabled: true,
      state: "enabled",
    },
    auto_resume_control_available: true,
  });
  const html = renderComponent(SessionSlot, makeSessionSlotProps({
    session,
    options: [session],
    openSlotMenuKey: "slot-0",
  }));
  const menuStart = html.indexOf('<div class="slot-title-dropdown"');
  const menuEnd = html.indexOf("</details>", menuStart);
  const menuHtml = html.slice(menuStart, menuEnd);

  assert.match(html, /<button[^>]*class="[^"]*auto-resume-status-button[^"]*"/);
  assert.match(html, /aria-label="Cancel auto-resume for Test session"/);
  assert.doesNotMatch(menuHtml, /Cancel auto-resume|Enable auto-resume|Auto-resume unavailable/);
  assert.doesNotMatch(menuHtml, /auto-resume-menu-(?:item|note)/);
  assert.match(cssRuleFor(".auto-resume-status-button"), /cursor: pointer;/);
});

test("SessionSlot collapses resting auto-resume states to a glyph-only badge", async () => {
  const SessionSlot = await loadSessionSlot();
  // Every resting state (steady on/off plus the lingering event outcomes
  // cancelled/resumed/checking) collapses to the glyph; only live-detail states
  // (scheduled countdown, failures) keep visible text.
  for (const state of [
    "enabled",
    "armed",
    "disabled",
    "unavailable",
    "cancelled",
    "resumed",
    "checking",
  ] as const) {
    const session = makeSession({
      agent: "claude",
      auto_resume_control_available: true,
      auto_resume: {
        schema_version: "agent-session.auto-resume.v1",
        supported: state !== "unavailable",
        // Mirrors the real daemon payload (armed/checking happen while enabled).
        // The badge only branches on `enabled` in the contractUnknown path, so
        // for these non-unknown states it does not change the icon-only outcome.
        enabled: state === "enabled" || state === "armed" || state === "checking",
        state,
      },
    });
    const html = renderComponent(SessionSlot, makeSessionSlotProps({
      session,
      options: [session],
    }));
    // The glyph carries the state; the full label stays accessible via
    // title/aria, but no persistent text column is rendered.
    assert.match(html, /auto-resume-icon-only/, state);
    assert.match(html, /auto-resume-status-glyph/, state);
    assert.doesNotMatch(html, /auto-resume-status-main/, state);
    // Colour is now the only at-a-glance signal, so the per-state class must be
    // present for the stylesheet to bucket it.
    assert.match(html, new RegExp(`auto-resume-${state}`), state);
  }

  // The action is the accessible name, while the current state remains in the
  // hover description.
  const enabled = makeSession({
    agent: "claude",
    auto_resume_control_available: true,
    auto_resume: {
      schema_version: "agent-session.auto-resume.v1",
      supported: true,
      enabled: true,
      state: "enabled",
    },
  });
  const enabledHtml = renderComponent(SessionSlot, makeSessionSlotProps({
    session: enabled,
    options: [enabled],
  }));
  assert.match(enabledHtml, /aria-label="Cancel auto-resume for Test session"/);
  assert.match(enabledHtml, /aria-describedby="[^"]+"/);
  assert.match(enabledHtml, /class="sr-only"[^>]*>Auto-resume on<\/span>/);
  assert.match(enabledHtml, /title="Cancel auto-resume for Test session\. Auto-resume on"/);
});

test("read-only slot-header status elements use the default cursor, not the header grab", async () => {
  // The slot header is draggable (cursor: grab), which its read-only status
  // children would otherwise inherit and read as grabbable. Each read-only
  // readout overrides to the default arrow; interactive controls keep pointer.
  for (const selector of [
    ".auto-resume-status",
    ".slot-ordinal",
    ".copy-feedback",
    ".slot-session-nav",
  ]) {
    assert.match(cssRuleFor(selector), /cursor: default;/, selector);
  }
  // The prev/next navigation control is genuinely clickable and stays pointer.
  assert.match(cssRuleFor(".slot-session-nav-button"), /cursor: pointer;/);
  assert.match(cssRuleFor(".account-status"), /cursor: pointer;/);
});

test("bound Codex account status uses a distinct Night Owl account color", () => {
  assert.match(uiStyles(), /--account: #c792ea;/);
  assert.match(cssRuleFor(".account-bound"), /color: var\(--account\);/);
  assert.match(cssRuleFor(".account-bound"), /border-color: color-mix\(in srgb, var\(--account\) 42%, transparent\);/);
  assert.match(cssRuleFor(".account-usage-name"), /color: var\(--fg\);/);
});

test("account usage matches the provider and switch key, not the display label", async () => {
  const { findAccountUsage } = await ssr.loadModule<typeof import("../src/sessionAccounts.ts")>("/src/sessionAccounts.ts");
  const codex = { ...providerUsage("sym"), switch_key: "sym" };
  const claude = { ...providerUsage("max@example.com"), provider: "claude", switch_key: "20X" };
  assert.equal(findAccountUsage([codex, claude], "codex", "sym"), codex);
  assert.equal(findAccountUsage([codex, claude], "claude", "20X"), claude);
  // A Claude entry is labelled by its email but switched by its profile.
  assert.equal(findAccountUsage([codex, claude], "claude", "max@example.com"), undefined);
  assert.equal(findAccountUsage([codex, claude], "claude", "sym"), undefined);
  assert.equal(findAccountUsage([{ ...codex, switch_key: undefined }], "codex", "sym"), undefined);
});

test("auto-resume glyph colour buckets resolve to their intended tokens", async () => {
  // Glyph-only states share one glyph, so colour is their sole visual signal.
  // Lock each bucket's token so a dropped or mis-bucketed colour is caught.
  // cssRuleFor matches the selector immediately before `{`, so grouped rules are
  // queried by their last (unique) selector.
  assert.match(cssRuleFor(".auto-resume-status"), /color: var\(--accent\);/); // base accent
  assert.match(cssRuleFor(".auto-resume-checking"), /color: var\(--accent\);/); // enabled/armed/checking
  assert.match(cssRuleFor(".auto-resume-cancelled"), /color: var\(--muted\);/); // disabled/unavailable/cancelled
  assert.match(cssRuleFor(".auto-resume-resumed"), /color: var\(--ok\);/);
  assert.match(cssRuleFor(".auto-resume-unknown-active"), /color: var\(--warn\);/); // failures + unknown-active
});

test("SessionSlot preserves icon-only steady-state detail in the accessible label", async () => {
  const SessionSlot = await loadSessionSlot();
  // Disabled with controls unavailable produces a detail line that is no longer
  // rendered as visible text for the glyph-only badge; it must survive in the
  // accessible label so assistive tech still surfaces it.
  const session = makeSession({
    agent: "claude",
    auto_resume_control_available: false,
    auto_resume: {
      schema_version: "agent-session.auto-resume.v1",
      supported: true,
      enabled: false,
      state: "disabled",
    },
  });
  const html = renderComponent(SessionSlot, makeSessionSlotProps({
    session,
    options: [session],
  }));
  assert.match(html, /auto-resume-icon-only/);
  assert.match(html, /aria-label="Auto-resume off: Controls unavailable"/);
  assert.match(html, /title="Auto-resume off: Controls unavailable"/);
  // The detail is accessibility-only for the compact badge: no visible column.
  assert.doesNotMatch(html, /auto-resume-status-detail/);
});

test("SessionSlot keeps visible text only for live-detail auto-resume states", async () => {
  const SessionSlot = await loadSessionSlot();
  // Only states carrying live, must-read detail keep a visible text column:
  // the scheduled countdown and the failure states (retrying/failed). A
  // regression that folded one of these into the glyph-only set is caught here.
  const textStates = [
    ["scheduled", true],
    ["transient_failure", true],
    ["terminal_failure", true],
  ] as const;
  for (const [state, enabled] of textStates) {
    const session = makeSession({
      agent: "claude",
      auto_resume_control_available: true,
      auto_resume: {
        schema_version: "agent-session.auto-resume.v1",
        supported: true,
        enabled,
        state,
        ...(state === "scheduled" ? { scheduled_at: "2026-07-12T12:34:56Z" } : {}),
        ...(state === "transient_failure" || state === "terminal_failure"
          ? { failure_reason: "scheduler_error" as const }
          : {}),
      },
    });
    const html = renderComponent(SessionSlot, makeSessionSlotProps({
      session,
      options: [session],
      now: Date.parse("2026-07-12T12:30:00Z"),
    }));
    assert.doesNotMatch(html, /auto-resume-icon-only/, state);
    assert.match(html, /auto-resume-status-main/, state);
  }

  // Unknown-active is a distinct visualState branch and must also stay text.
  const unknownActive = makeSession({
    agent: "claude",
    auto_resume_control_available: true,
    auto_resume: {
      schema_version: "agent-session.auto-resume.v1",
      supported: true,
      enabled: true,
      state: "unknown",
      failure_reason: "unknown",
    },
  });
  const unknownHtml = renderComponent(SessionSlot, makeSessionSlotProps({
    session: unknownActive,
    options: [unknownActive],
  }));
  assert.doesNotMatch(unknownHtml, /auto-resume-icon-only/);
  assert.match(unknownHtml, /auto-resume-status-main/);
  assert.match(unknownHtml, /Auto-resume active/);

  // The scheduled countdown text renders in place.
  const scheduled = makeSession({
    agent: "claude",
    auto_resume_control_available: true,
    auto_resume: {
      schema_version: "agent-session.auto-resume.v1",
      supported: true,
      enabled: true,
      state: "scheduled",
      scheduled_at: "2026-07-12T12:34:56Z",
    },
  });
  const scheduledHtml = renderComponent(SessionSlot, makeSessionSlotProps({
    session: scheduled,
    options: [scheduled],
    now: Date.parse("2026-07-12T12:30:00Z"),
  }));
  assert.match(scheduledHtml, /Auto-resume scheduled in 5m/);
});

test("SessionSlot offers opt-in only for supported sessions and explains unavailable controls", async () => {
  const SessionSlot = await loadSessionSlot();
  const supported = makeSession({
    agent: "claude",
    auto_resume: {
      schema_version: "agent-session.auto-resume.v1",
      supported: true,
      enabled: false,
      state: "disabled",
    },
    auto_resume_control_available: true,
  });
  const supportedHtml = renderComponent(SessionSlot, makeSessionSlotProps({
    session: supported,
    options: [supported],
    openSlotMenuKey: "slot-0",
  }));
  assert.match(supportedHtml, /aria-label="Enable auto-resume for Test session"/);

  const old = makeSession({ agent: "claude" });
  const oldHtml = renderComponent(SessionSlot, makeSessionSlotProps({
    session: old,
    options: [old],
    openSlotMenuKey: "slot-0",
  }));
  assert.match(oldHtml, /Auto-resume unavailable/);
  assert.match(oldHtml, /role="status"/);
  assert.match(oldHtml, /Unsupported runtime/);
  assert.doesNotMatch(oldHtml, /aria-label="Enable auto-resume/);

  const controlsUnavailable = makeSession({
    agent: "claude",
    auto_resume: {
      schema_version: "agent-session.auto-resume.v1",
      supported: true,
      enabled: false,
      state: "disabled",
    },
    auto_resume_control_available: false,
  });
  const controlsUnavailableHtml = renderComponent(SessionSlot, makeSessionSlotProps({
    session: controlsUnavailable,
    options: [controlsUnavailable],
    openSlotMenuKey: "slot-0",
  }));
  assert.match(controlsUnavailableHtml, /role="status"/);
  assert.match(controlsUnavailableHtml, /Controls unavailable/);
  assert.doesNotMatch(controlsUnavailableHtml, /aria-label="Enable auto-resume/);

});

test("SessionSlot distinguishes an invalid supplied auto-resume projection from old runtime absence", async () => {
  const SessionSlot = await loadSessionSlot();
  const invalidProjection = makeSession({
    agent: "claude",
    auto_resume: null,
    auto_resume_control_available: true,
  });
  const html = renderComponent(SessionSlot, makeSessionSlotProps({
    session: invalidProjection,
    options: [invalidProjection],
    openSlotMenuKey: "slot-0",
  }));

  assert.match(html, /Auto-resume unavailable/);
  assert.match(html, /Invalid runtime state/);
  assert.doesNotMatch(html, /Unsupported runtime/);
  assert.doesNotMatch(html, /aria-label="Enable auto-resume/);
});

test("SessionSlot explains state-unavailable projection and suppresses enable", async () => {
  const SessionSlot = await loadSessionSlot();
  const stateUnavailable = makeSession({
    agent: "claude",
    auto_resume: {
      schema_version: "agent-session.auto-resume.v1",
      supported: true,
      enabled: false,
      state: "terminal_failure",
      failure_reason: "state_unavailable",
    },
    auto_resume_control_available: true,
  });
  const stateUnavailableHtml = renderComponent(SessionSlot, makeSessionSlotProps({
    session: stateUnavailable,
    options: [stateUnavailable],
    openSlotMenuKey: "slot-0",
  }));
  assert.doesNotMatch(stateUnavailableHtml, /aria-label="Enable auto-resume/);
  assert.match(stateUnavailableHtml, /role="status"/);
  assert.match(stateUnavailableHtml, /State unavailable/);
});

test("SessionSlot preserves cancellation for unknown active metadata and fails closed for unknown inactive metadata", async () => {
  const SessionSlot = await loadSessionSlot();
  const active = makeSession({
    agent: "claude",
    auto_resume_control_available: true,
    auto_resume: {
      schema_version: "agent-session.auto-resume.v1",
      supported: true,
      enabled: true,
      state: "unknown",
      failure_reason: "unknown",
    },
  });
  const activeHtml = renderComponent(SessionSlot, makeSessionSlotProps({
    session: active,
    options: [active],
    openSlotMenuKey: "slot-0",
  }));
  assert.match(activeHtml, /Auto-resume active/);
  assert.match(activeHtml, /Unknown state or failure/);
  assert.match(activeHtml, /aria-label="Cancel auto-resume for Test session"/);

  const inactive = makeSession({
    agent: "claude",
    auto_resume_control_available: true,
    auto_resume: { ...active.auto_resume!, enabled: false },
  });
  const inactiveHtml = renderComponent(SessionSlot, makeSessionSlotProps({
    session: inactive,
    options: [inactive],
    openSlotMenuKey: "slot-0",
  }));
  assert.match(inactiveHtml, /Auto-resume unavailable/);
  assert.match(inactiveHtml, /role="status"/);
  assert.match(inactiveHtml, /State unknown/);
  assert.doesNotMatch(inactiveHtml, /aria-label="Enable auto-resume/);
});

test("SessionSlot composes auto-resume state and control-unavailable details", async () => {
  const SessionSlot = await loadSessionSlot();
  const cases = [
    {
      session: makeSession({
        agent: "claude",
        auto_resume_control_available: false,
        auto_resume: {
          schema_version: "agent-session.auto-resume.v1",
          supported: true,
          enabled: true,
          state: "unknown",
          failure_reason: "unknown",
        },
      }),
      details: ["Unknown state or failure", "Controls unavailable"],
    },
    {
      session: makeSession({
        agent: "claude",
        auto_resume_control_available: false,
        auto_resume: {
          schema_version: "agent-session.auto-resume.v1",
          supported: true,
          enabled: false,
          state: "terminal_failure",
          failure_reason: "scheduler_error",
        },
      }),
      details: ["Scheduler error", "Controls unavailable"],
    },
  ] as const;

  for (const mobile of [false, true]) {
    for (const item of cases) {
      const html = renderComponent(SessionSlot, makeSessionSlotProps({
        session: item.session,
        options: [item.session],
        viewport: { mobile },
      }));
      assert.match(html, /role="status"/, `mobile=${mobile}`);
      assert.doesNotMatch(html, /aria-label="(?:Enable|Cancel) auto-resume/, `mobile=${mobile}`);
      for (const detail of item.details) {
        assert.match(html, new RegExp(detail), `${detail} mobile=${mobile}`);
      }
    }
  }
});

test("SessionSlot exposes every auto-resume state label and failure detail on desktop and mobile", async () => {
  const SessionSlot = await loadSessionSlot();
  // Locks that each state's label reaches the badge markup — as visible text for
  // the text states and via title/aria for the glyph-only states (this matches
  // the whole-HTML string either way). The glyph-vs-text split itself is pinned
  // by the dedicated resting/live-detail tests above; the failure-detail check
  // below still exercises genuinely visible text, since failures keep it.
  const cases = [
    ["disabled", "Auto-resume off"],
    ["enabled", "Auto-resume on"],
    ["armed", "Auto-resume armed"],
    ["scheduled", "Auto-resume scheduled"],
    ["checking", "Auto-resume checking usage"],
    ["resumed", "Auto-resume resumed"],
    ["cancelled", "Auto-resume cancelled"],
    ["transient_failure", "Auto-resume retrying"],
    ["terminal_failure", "Auto-resume failed"],
  ] as const;
  for (const mobile of [false, true]) {
    for (const [state, expected] of cases) {
      const session = makeSession({
        agent: "claude",
        auto_resume_control_available: true,
        auto_resume: {
          schema_version: "agent-session.auto-resume.v1",
          supported: true,
          enabled: state !== "disabled" && state !== "cancelled" && state !== "resumed",
          state,
          ...(state === "transient_failure" || state === "terminal_failure"
            ? { failure_reason: "scheduler_error" as const }
            : {}),
        },
      });
      const html = renderComponent(SessionSlot, makeSessionSlotProps({
        session,
        options: [session],
        viewport: { mobile },
      }));
      assert.match(html, new RegExp(expected), `${state} mobile=${mobile}`);
      if (state === "transient_failure" || state === "terminal_failure") {
        assert.match(html, /Scheduler error/, `${state} reason mobile=${mobile}`);
      }
    }
  }
});

test("SessionSlot keeps the provider-default Codex badge visible with account actions", async () => {
  const SessionSlot = await loadSessionSlot();
  const session = makeSession({
    agent: "codex",
    turn_state: {
      schema_version: "agent-session.turn-state.v1",
      phase: "waiting",
      phase_changed_at: "2026-07-14T00:00:00Z",
      revision: 2,
      source: { kind: "provider_hook", provider: "codex", confidence: "authoritative" },
    },
    codex_account: {
      schema_version: "agent-session.codex-account.v1",
      supported: true,
      state: "unbound",
      revision: 0,
    },
  });
  const html = renderComponent(SessionSlot, makeSessionSlotProps({
    session,
    options: [session],
    openSlotMenuKey: "slot-0",
    accounts: [{ account: "account-a", label: "Account A" }],
  } as never));

  assert.match(html, /account-status account-status-codex account-unbound/);
  assert.match(html, /aria-label="Codex default account\. View usage details"/);
  assert.match(html, />default<\/button>/);
  assert.match(html, /aria-label="Switch Test session to Codex account account-a"/);
});

test("SessionSlot shows the actual account captured from default at launch", async () => {
  const SessionSlot = await loadSessionSlot();
  const session = makeSession({
    agent: "codex",
    codex_account: {
      schema_version: "agent-session.codex-account.v1",
      supported: true,
      state: "bound",
      selected_account: "account-a",
      effective_account: "account-a",
      selection_source: "default_at_launch",
      revision: 1,
      applied_runtime_id: "launch-hs-1",
    },
  });
  const html = renderComponent(SessionSlot, makeSessionSlotProps({
    session,
    options: [session],
    accounts: [{ account: "account-a", label: "Account A" }],
  } as never));

  assert.match(html, /aria-label="Codex default account account-a\. View usage details"/);
  assert.match(html, />default · account-a<\/button>/);
});

test("a working provider-default Codex session can queue its next account from the badge", async () => {
  const SessionSlot = await loadSessionSlot();
  const session = makeSession({
    agent: "codex",
    turn_state: {
      schema_version: "agent-session.turn-state.v1",
      phase: "working",
      phase_changed_at: "2026-07-25T00:00:00Z",
      revision: 3,
      source: { kind: "provider", provider: "codex", confidence: "exact" },
    },
    codex_account: {
      schema_version: "agent-session.codex-account.v1",
      supported: true,
      state: "unbound",
      revision: 0,
    },
  });
  const window = new Window({ url: "http://localhost" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    Event: globalThis.Event,
    MouseEvent: globalThis.MouseEvent,
    KeyboardEvent: globalThis.KeyboardEvent,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window,
    document: window.document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    KeyboardEvent: window.KeyboardEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  const selections: string[] = [];
  try {
    await act(async () => {
      root.render(createElement(SessionSlot, makeSessionSlotProps({
        session,
        options: [session],
        accounts: [
          { account: "account-a", label: "Account A" },
          { account: "account-b", label: "Account B" },
        ],
        onAccount: async (_target, account) => {
          selections.push(account);
        },
      })));
    });
    const trigger = container.querySelector<HTMLButtonElement>(".account-status");
    assert.ok(trigger);
    assert.equal(trigger.textContent, "default");
    await act(async () => {
      trigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    const choice = container.querySelector<HTMLButtonElement>(
      '[aria-label="Queue Codex account account-b for the next prompt"]',
    );
    assert.ok(choice);
    await act(async () => {
      choice.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    assert.deepEqual(selections, ["account-b"]);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
    window.close();
  }
});

test("SessionSlot keeps the bound Codex badge current and removes account choices from the title menu", async () => {
  const SessionSlot = await loadSessionSlot();
  const session = makeSession({
    agent: "codex",
    turn_state: {
      schema_version: "agent-session.turn-state.v1",
      phase: "waiting",
      phase_changed_at: "2026-07-14T00:00:00Z",
      revision: 2,
      source: { kind: "provider_hook", provider: "codex", confidence: "authoritative" },
    },
    codex_account: {
      schema_version: "agent-session.codex-account.v1",
      supported: true,
      state: "bound",
      selected_account: "account-a",
      revision: 3,
      applied_runtime_id: "launch-hs-1",
      next: {
        account: "account-b",
        revision: 1,
        state: "queued",
      },
    },
  });
  const html = renderComponent(SessionSlot, makeSessionSlotProps({
    session,
    options: [session],
    openSlotMenuKey: "slot-0",
    accounts: [
      { account: "account-a", label: "Account A", plan: "team" },
      { account: "account-b", label: "Account B" },
    ],
  } as never));

  assert.match(html, /aria-label="Codex account account-a\. Next account account-b\. View usage details"/);
  assert.doesNotMatch(html, /title="Codex account account-a\. View usage details"/);
  assert.match(html, /aria-haspopup="dialog"/);
  assert.match(html, />account-a<\/button>/);
  assert.doesNotMatch(html, />Codex account account-a</);
  assert.doesNotMatch(html, /aria-label="Switch Test session to Codex account account-b"/);
  assert.doesNotMatch(html, /Switch Test session to Codex account account-a/);
});

test("focused mobile uses the same current Codex account badge and popover contract", async () => {
  const SessionSlot = await loadSessionSlot();
  const session = makeSession({
    agent: "codex",
    codex_account: {
      schema_version: "agent-session.codex-account.v1",
      supported: true,
      state: "bound",
      selected_account: "account-a",
      revision: 3,
      applied_runtime_id: "launch-hs-1",
      next: { account: "account-b", revision: 1, state: "queued" },
    },
  });
  const html = renderComponent(SessionSlot, makeSessionSlotProps({
    session,
    options: [session],
    focused: true,
    viewport: { mobile: true },
    accounts: [{ account: "account-a" }, { account: "account-b" }],
  } as never));

  assert.match(html, /aria-label="Codex account account-a\. Next account account-b\. View usage details"/);
  assert.match(html, />account-a<\/button>/);
});

test("working bound Codex account opens a pinned current and next usage dialog", async () => {
  const SessionSlot = await loadSessionSlot();
  const DashboardUsageContext = await loadDashboardUsageContext();
  const session = makeSession({
    agent: "codex",
    machine: "machine-a",
    turn_state: {
      schema_version: "agent-session.turn-state.v1",
      phase: "working",
      phase_changed_at: "2026-07-22T12:00:00Z",
      revision: 3,
      source: { kind: "provider", provider: "codex", confidence: "exact" },
    },
    codex_account: {
      schema_version: "agent-session.codex-account.v1",
      supported: true,
      state: "bound",
      selected_account: "account-a",
      revision: 2,
      applied_runtime_id: "launch-hs-1",
      next: {
        account: "account-b",
        revision: 3,
        state: "queued",
      },
    },
  });
  const window = new Window({ url: "http://localhost" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    Event: globalThis.Event,
    MouseEvent: globalThis.MouseEvent,
    KeyboardEvent: globalThis.KeyboardEvent,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window,
    document: window.document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    KeyboardEvent: window.KeyboardEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  const selections: string[] = [];
  const provider = (account: string, windows: ProviderUsage["windows"]): ProviderUsage => ({
    provider: "codex",
    account,
    switch_key: account,
    label: "Codex",
    ok: true,
    stale: false,
    plan: account === "account-a" ? "pro" : "team",
    windows,
    updated_at: Math.floor(Date.parse("2026-07-06T00:00:30Z") / 1000),
    note: null,
    error: null,
    reason_code: null,
  });
  const usage: DashboardUsageSnapshot = {
    providers: [
      provider("account-b", [{
        key: "private",
        label: "ACCOUNT_B_WINDOW",
        used_percent: 1,
        window_minutes: 60,
        resets_at: null,
      }]),
      provider("account-a", [
        {
          key: "5h",
          label: "5h",
          used_percent: 86,
          window_minutes: 300,
          resets_at: Math.floor(Date.parse("2026-07-06T01:00:00Z") / 1000),
        },
        {
          key: "weekly",
          label: "Weekly",
          used_percent: 22,
          window_minutes: 10080,
          resets_at: Math.floor(Date.parse("2026-07-07T00:00:00Z") / 1000),
        },
      ]),
    ],
    reachable: true,
    loaded: true,
    error: null,
  };
  let renderedSession = session;
  let activeCodexAccounts = [
    { account: "account-a", label: "Account A", plan: "pro" },
    { account: "account-b", label: "Account B", plan: "team" },
    { account: "account-c", label: "Account C", plan: "pro" },
  ];
  const renderUsage = async (value: DashboardUsageSnapshot) => {
    await act(async () => {
      root.render(createElement(
        DashboardUsageContext.Provider,
        { value },
        createElement(SessionSlot, makeSessionSlotProps({
          session: renderedSession,
          options: [renderedSession],
          accounts: activeCodexAccounts,
          onAccount: async (_target, account) => { selections.push(account); },
        })),
      ));
    });
  };
  try {
    await renderUsage(usage);
    const trigger = container.querySelector<HTMLButtonElement>(".account-status");
    const popoverRoot = container.querySelector<HTMLElement>(".account-usage-root");
    assert.ok(trigger);
    assert.ok(popoverRoot);
    assert.equal(trigger.tagName, "BUTTON");
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    await act(async () => {
      popoverRoot.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 300));
    });
    const tooltip = container.querySelector('[role="tooltip"]');
    assert.ok(tooltip);
    assertNoElement(tooltip, "button");
    await act(async () => {
      trigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    const dialog = container.querySelector('[role="dialog"]');
    assert.ok(dialog);
    assert.match(dialog.textContent ?? "", /Current/);
    assert.match(dialog.textContent ?? "", /account-a/);
    assert.match(dialog.textContent ?? "", /pro/);
    assert.match(dialog.textContent ?? "", /5h14% left/);
    assert.match(dialog.textContent ?? "", /Weekly78% left/);
    assert.match(dialog.textContent ?? "", /Next/);
    assert.match(dialog.textContent ?? "", /account-b/);
    assert.match(dialog.textContent ?? "", /Queued for the next prompt/);
    assert.match(dialog.textContent ?? "", /ACCOUNT_B_WINDOW99% left/);
    const queueAccountC = dialog.querySelector<HTMLButtonElement>(
      '[aria-label="Queue Codex account account-c for the next prompt"]',
    );
    const keepCurrent = dialog.querySelector<HTMLButtonElement>(
      '[aria-label="Keep current Codex account account-a and cancel the next account"]',
    );
    assert.ok(queueAccountC);
    assert.ok(keepCurrent);
    await act(async () => {
      queueAccountC.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
      keepCurrent.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    assert.deepEqual(selections, ["account-c", "account-a"]);
    await act(async () => {
      popoverRoot.dispatchEvent(new window.MouseEvent("mouseout", { bubbles: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 150));
    });
    assert.ok(container.querySelector('[role="dialog"]'));
    const outside = window.document.createElement("button");
    window.document.body.append(outside);
    await act(async () => {
      outside.dispatchEvent(new window.Event("pointerdown", { bubbles: true, cancelable: true }));
    });
    assertNoElement(container, '[role="dialog"]');

    await renderUsage({ ...usage, providers: [], loaded: false });
    await act(async () => {
      trigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    assert.match(container.querySelector('[role="dialog"]')?.textContent ?? "", /Loading usage/);
    await act(async () => {
      window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    assertNoElement(container, '[role="dialog"]');
    assertActiveElement(window, trigger);

    await renderUsage({ ...usage, providers: [] });
    await act(async () => {
      trigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    assert.match(
      container.querySelector('[role="dialog"]')?.textContent ?? "",
      /No usage data available for this account/,
    );
    await act(async () => {
      window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    await renderUsage({ ...usage, reachable: false, error: "reader unavailable" });
    await act(async () => {
      trigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    assert.match(
      container.querySelector('[role="dialog"]')?.textContent ?? "",
      /Usage refresh unavailable; showing the last result/,
    );

    renderedSession = {
      ...session,
      codex_account: {
        ...session.codex_account!,
        next: {
          account: "account-b",
          revision: 4,
          state: "failed",
          failure_reason: "apply_failed",
        },
      },
    };
    await renderUsage(usage);
    assert.ok(container.querySelector('[aria-label="Retry Codex account account-b for the next prompt"]'));

    renderedSession = {
      ...session,
      codex_account: {
        ...session.codex_account!,
        next: {
          account: "account-b",
          revision: 4,
          state: "failed",
          failure_reason: "unknown",
        },
      },
    };
    await renderUsage(usage);
    const unknownFailureDialog = container.querySelector<HTMLElement>('[role="dialog"]');
    assert.ok(unknownFailureDialog);
    assert.match(unknownFailureDialog.textContent ?? "", /Account choices are disabled/);
    assertNoElement(unknownFailureDialog, "button");

    renderedSession = {
      ...session,
      codex_account: {
        ...session.codex_account!,
        next: { revision: 0, state: "unknown", failure_reason: "unknown" },
      },
    };
    await renderUsage(usage);
    const unknownDialog = container.querySelector<HTMLElement>('[role="dialog"]');
    assert.ok(unknownDialog);
    assert.match(unknownDialog.textContent ?? "", /Account choices are disabled/);
    assertNoElement(unknownDialog, "button");

    renderedSession = { ...session, codex_account: { ...session.codex_account!, next: undefined } };
    activeCodexAccounts = [];
    await renderUsage(usage);
    const unavailableDialog = container.querySelector<HTMLElement>('[role="dialog"]');
    assert.ok(unavailableDialog);
    assert.match(unavailableDialog.textContent ?? "", /Account choices are unavailable on this machine/);
    assertNoElement(unavailableDialog, "button");
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
  }
});

test("SessionSlot fails closed while Codex account binding is pending", async () => {
  const SessionSlot = await loadSessionSlot();
  const session = makeSession({
    agent: "codex",
    codex_account: {
      schema_version: "agent-session.codex-account.v1",
      supported: true,
      state: "pending",
      selected_account: "account-a",
      revision: 4,
    },
  });
  const html = renderComponent(SessionSlot, makeSessionSlotProps({
    session,
    options: [session],
    openSlotMenuKey: session.id,
    accounts: [{ account: "account-a", label: "Account A" }],
  } as never));

  assert.match(html, /aria-label="Codex account switching to account-a\. View usage details"/);
  assert.match(html, />account-a<\/button>/);
  assert.doesNotMatch(html, /aria-label="Switch Test session/);
});

test("SessionSlot keeps a failed Codex binding read-only", async () => {
  const SessionSlot = await loadSessionSlot();
  const session = makeSession({
    agent: "codex",
    codex_account: {
      schema_version: "agent-session.codex-account.v1",
      supported: true,
      state: "failed",
      selected_account: "account-a",
      revision: 4,
      failure_reason: "apply_failed",
    },
  });
  const html = renderComponent(SessionSlot, makeSessionSlotProps({
    session,
    options: [session],
    openSlotMenuKey: session.id,
    accounts: [
      { account: "account-a", label: "Account A" },
      { account: "account-b", label: "Account B" },
    ],
  } as never));

  assert.match(html, /aria-label="Codex account switch failed for account-a\. View usage details"/);
  assert.doesNotMatch(html, /Switch Test session to Codex account/);
});
test("SessionSlot renders every durable startup failure class on desktop and mobile", async () => {
  const SessionSlot = await loadSessionSlot();
  const cases = [
    ["runtime-helper-unavailable", "proxy", "Session runtime helper is unavailable after an upgrade.", true, "Update or restart the session runtime, then retry."],
    ["agent-binary-unavailable", "runtime", "The selected agent CLI could not be started.", false, "Check that the selected agent is installed and configured."],
    ["working-directory-unavailable", "record", "The selected working directory is unavailable.", false, "Restore the working directory or create a new session elsewhere."],
    ["terminal-runtime-create-failed", "tmux", "The terminal runtime could not be created.", true, "Retry the session."],
    ["app-server-start-failed", "app_server", "The agent control server did not become ready.", true, "Retry the session."],
    ["proxy-start-failed", "proxy", "Agent Console could not connect the terminal to the agent runtime.", true, "Retry the session."],
    ["provider-client-exited", "provider_client", "The agent exited before the session was ready.", true, "Retry the session."],
    ["provider-configuration-rejected", "provider_client", "The agent needs configuration or sign-in on this machine.", false, "Configure or sign in to the agent on this machine."],
    ["startup-timeout", "initial_connection", "Session startup timed out; the outcome may be uncertain.", false, "Inspect the machine before trying again."],
    ["startup-exited", "initial_connection", "The session stopped during startup.", true, "Retry the session."],
  ] as const;

  for (const mobile of [false, true]) {
    for (const [failureCode, stage, message, retrySafe, action] of cases) {
      const session = makeSession({
        status: "stopped",
        resumable: retrySafe,
        ...(failureCode === "runtime-helper-unavailable"
          ? { runtime_restart_available: true }
          : {}),
        startup: {
          schema_version: "agent-session.startup.v1",
          state: "failed",
          stage,
          started_at: "2026-07-14T10:00:00Z",
          failure_code: failureCode,
          message,
          occurred_at: "2026-07-14T10:00:03Z",
          retry_safe: retrySafe,
        },
      });
      const html = renderComponent(SessionSlot, makeSessionSlotProps({
        session,
        options: [session],
        viewport: { mobile },
      }));

      assert.match(html, /Session failed to start/, `${failureCode} mobile=${mobile}`);
      assert.match(html, new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), failureCode);
      assert.match(html, new RegExp(action.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), failureCode);
      assert.match(html, /<time dateTime="2026-07-14T10:00:03Z"/, failureCode);
      assert.match(html, new RegExp(`data-startup-stage="${stage}"`), failureCode);
      if (retrySafe) {
        assert.match(html, />Retry</, failureCode);
      } else {
        assert.match(html, />Copy diagnostics</, failureCode);
      }
    }
  }
});

test("SessionSlot does not infer startup failure from ordinary stopped, old-daemon, unreachable, starting, or ready sessions", async () => {
  const SessionSlot = await loadSessionSlot();
  const sessions = [
    makeSession({ status: "stopped", resumable: true }),
    makeSession({ status: "stopped", resumable: false }),
    makeSession({ status: "stopped", startup: null }),
    makeSession({ status: "stopped", startup: {
      schema_version: "agent-session.startup.v1",
      state: "starting",
      stage: "runtime",
      started_at: "2026-07-14T10:00:00Z",
    } }),
    makeSession({ status: "stopped", startup: {
      schema_version: "agent-session.startup.v1",
      state: "ready",
      stage: "initial_connection",
      started_at: "2026-07-14T10:00:00Z",
    } }),
  ];
  for (const [index, session] of sessions.entries()) {
    const html = renderComponent(SessionSlot, makeSessionSlotProps({
      session,
      options: [session],
      machineReachable: index !== 1,
    }));
    assert.doesNotMatch(html, /Session failed to start/);
  }
});



test("SessionSlot keeps the normal retry fallback when runtime restart is unavailable", async () => {
  const SessionSlot = await loadSessionSlot();
  const session = makeSession({
    machine: "mesa",
    status: "stopped",
    resumable: true,
    startup: {
      schema_version: "agent-session.startup.v1",
      state: "failed",
      stage: "proxy",
      started_at: "2026-07-14T10:00:00Z",
      failure_code: "runtime-helper-unavailable",
      message: "Session runtime helper is unavailable after an upgrade.",
      occurred_at: "2026-07-14T10:00:03Z",
      retry_safe: true,
    },
  });
  const html = renderComponent(SessionSlot, makeSessionSlotProps({
    session,
    options: [session],
  }));

  assert.doesNotMatch(html, />Restart runtime &amp; retry</);
  assert.match(html, />Retry</);

  const nonResumable = { ...session, machine: "summit", resumable: false, runtime_restart_available: true };
  const nonResumableHtml = renderComponent(SessionSlot, makeSessionSlotProps({
    session: nonResumable,
    options: [nonResumable],
  }));
  assert.doesNotMatch(nonResumableHtml, />Restart runtime &amp; retry</);
  assert.match(nonResumableHtml, />Copy diagnostics</);
});

test("SessionSlot offers copied diagnostic feedback and uses Copy diagnostics when retry is not currently safe", async () => {
  const SessionSlot = await loadSessionSlot();
  const session = makeSession({
    status: "stopped",
    resumable: false,
    startup: {
      schema_version: "agent-session.startup.v1",
      state: "failed",
      stage: "tmux",
      started_at: "2026-07-14T10:00:00Z",
      failure_code: "terminal-runtime-create-failed",
      message: "The terminal runtime could not be created.",
      occurred_at: "2026-07-14T10:00:03Z",
      retry_safe: true,
    },
  });
  const html = renderComponent(SessionSlot, makeSessionSlotProps({
    session,
    options: [session],
    copiedStartupDiagnosticsKey: "summit/hs-1",
  }));

  assert.match(html, />Diagnostics copied</);
  assert.doesNotMatch(html, />Retry</);
});

function claudeSession(claudeAccount: Session["claude_account"], overrides: Partial<Session> = {}): Session {
  return makeSession({
    agent: "claude",
    session_incarnation: "launch-c1",
    ...(claudeAccount === undefined ? {} : { claude_account: claudeAccount }),
    ...overrides,
  });
}

const claudeBound = {
  schema_version: "agent-session.claude-account.v1",
  supported: true,
  state: "bound",
  selected_account: "alpha",
  selection_source: "default_at_launch",
  revision: 1,
  applied_runtime_id: "launch-c1",
} as const;

test("SessionSlot labels a Claude session by its default-at-launch or chosen account", async () => {
  const SessionSlot = await loadSessionSlot();
  const defaultHtml = renderSlot(SessionSlot, claudeSession(claudeBound));
  assert.match(defaultHtml, /account-status-claude/);
  assert.match(defaultHtml, />default · alpha<\/button>/);
  assert.match(defaultHtml, /aria-label="Claude default account alpha\. View usage details"/);

  const chosenHtml = renderSlot(SessionSlot, claudeSession({ ...claudeBound, selection_source: "explicit" }));
  assert.match(chosenHtml, />alpha<\/button>/);
  assert.match(chosenHtml, /aria-label="Claude account alpha\. View usage details"/);

  const queuedHtml = renderSlot(SessionSlot, claudeSession({
    ...claudeBound,
    selection_source: "explicit",
    next: { account: "beta", revision: 2, state: "queued" },
  }));
  assert.match(queuedHtml, /Next account beta/);
});

test("SessionSlot hides the Claude account badge without a supported view", async () => {
  const SessionSlot = await loadSessionSlot();
  for (const account of [undefined, null, { ...claudeBound, supported: false, state: "unsupported" as const }]) {
    const html = renderSlot(SessionSlot, claudeSession(account));
    assert.doesNotMatch(html, /account-status-claude/, JSON.stringify(account));
  }
  assert.doesNotMatch(renderSlot(SessionSlot, makeSession({ agent: "codex" })), /account-status-claude/);
});

test("Claude account popover explains restart-and-resume and switches to another account", async () => {
  const SessionSlot = await loadSessionSlot();
  const session = claudeSession(claudeBound);
  const window = new Window({ url: "http://localhost" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    Event: globalThis.Event,
    MouseEvent: globalThis.MouseEvent,
    KeyboardEvent: globalThis.KeyboardEvent,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window,
    document: window.document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    KeyboardEvent: window.KeyboardEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  const selections: string[] = [];
  try {
    await act(async () => {
      root.render(createElement(SessionSlot, makeSessionSlotProps({
        session,
        options: [session],
        accounts: [
          { account: "alpha", label: "Alpha" },
          { account: "beta", label: "Beta" },
        ],
        onAccount: async (_target, account) => {
          selections.push(account);
        },
      })));
    });
    const trigger = container.querySelector<HTMLButtonElement>(".account-status-claude");
    assert.ok(trigger);
    await act(async () => {
      trigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    assert.match(
      container.textContent ?? "",
      /Switching restarts this session and resumes the conversation on the new account/,
    );
    assertNoElement(container, '[aria-label="Switch Claude account to alpha"]');
    const choice = container.querySelector<HTMLButtonElement>('[aria-label="Switch Claude account to beta"]');
    assert.ok(choice);
    await act(async () => {
      choice.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    assert.deepEqual(selections, ["beta"]);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
    window.close();
  }
});

test("Claude account popover offers Keep current and marks the queued next account", async () => {
  const SessionSlot = await loadSessionSlot();
  const session = claudeSession({
    ...claudeBound,
    selection_source: "explicit",
    next: { account: "beta", revision: 2, state: "queued" },
  });
  const window = new Window({ url: "http://localhost" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    Event: globalThis.Event,
    MouseEvent: globalThis.MouseEvent,
    KeyboardEvent: globalThis.KeyboardEvent,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window,
    document: window.document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    KeyboardEvent: window.KeyboardEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  const selections: string[] = [];
  try {
    await act(async () => {
      root.render(createElement(SessionSlot, makeSessionSlotProps({
        session,
        options: [session],
        accounts: [
          { account: "alpha", label: "Alpha" },
          { account: "beta", label: "Beta" },
          { account: "gamma", label: "Gamma" },
        ],
        onAccount: async (_target, account) => {
          selections.push(account);
        },
      })));
    });
    const trigger = container.querySelector<HTMLButtonElement>(".account-status-claude");
    assert.ok(trigger);
    await act(async () => {
      trigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    const queued = container.querySelector<HTMLButtonElement>('[aria-label="Switch Claude account to beta"]');
    assert.ok(queued);
    assert.equal(queued.disabled, true);
    assert.equal(queued.getAttribute("aria-current"), "true");
    const other = container.querySelector<HTMLButtonElement>('[aria-label="Switch Claude account to gamma"]');
    assert.ok(other);
    assert.equal(other.disabled, false);
    const keep = container.querySelector<HTMLButtonElement>(
      '[aria-label="Keep current Claude account alpha and cancel the next account"]',
    );
    assert.ok(keep);
    await act(async () => {
      keep.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    assert.deepEqual(selections, ["alpha"]);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
    window.close();
  }
});

async function withClaudeSlotDom(run: (window: Window, container: HTMLElement, root: ReturnType<typeof createRoot>) => Promise<void>) {
  const window = new Window({ url: "http://localhost" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    Event: globalThis.Event,
    MouseEvent: globalThis.MouseEvent,
    KeyboardEvent: globalThis.KeyboardEvent,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window,
    document: window.document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    KeyboardEvent: window.KeyboardEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  try {
    await run(window, container, root);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
    window.close();
  }
}

test("Claude account popover shows usage for its account and the account default now", async () => {
  const SessionSlot = await loadSessionSlot();
  const DashboardUsageContext = await loadDashboardUsageContext();
  const { AccountDefaultsProvider, EMPTY_ACCOUNT_DEFAULT } = await ssr.loadModule<typeof import("../src/accountDefaults.tsx")>("/src/accountDefaults.tsx");
  const session = claudeSession(claudeBound);
  const claudeUsage = (profile: string, email: string, usedPercent: number): ProviderUsage => ({
    ...providerUsage(email, [{ key: "5h", label: "5h", used_percent: usedPercent, window_minutes: 300, resets_at: null }]),
    provider: "claude",
    label: "Claude",
    profile,
    switch_key: profile,
  });
  const usage: DashboardUsageSnapshot = {
    // A Codex entry that shares the nickname is another provider's account.
    providers: [
      { ...providerUsage("alpha", [{ key: "5h", label: "5h", used_percent: 1, window_minutes: 300, resets_at: null }]), switch_key: "alpha" },
      claudeUsage("alpha", "alpha@example.com", 30),
      claudeUsage("beta", "beta@example.com", 60),
    ],
    reachable: true,
    loaded: true,
    error: null,
  };
  await withClaudeSlotDom(async (window, container, root) => {
    await act(async () => {
      root.render(createElement(
        AccountDefaultsProvider,
        {
          value: { codex: EMPTY_ACCOUNT_DEFAULT, claude: { ...EMPTY_ACCOUNT_DEFAULT, activeAccount: "beta", accounts: ["alpha","beta"], reachable: true, loaded: true } },
        },
        createElement(
          DashboardUsageContext.Provider,
          { value: usage },
          createElement(SessionSlot, makeSessionSlotProps({
            session,
            options: [session],
            accounts: [{ account: "alpha" }, { account: "beta" }],
          })),
        ),
      ));
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    });
    const trigger = container.querySelector<HTMLButtonElement>(".account-status-claude");
    assert.ok(trigger);
    await act(async () => {
      trigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
    assert.ok(dialog);
    const text = dialog.textContent ?? "";
    assert.match(text, /Selected from the default when this session launched/);
    assert.match(text, /Current.*alpha.*5h70% left/);
    assert.match(text, /Default now.*beta.*5h40% left/);
    assert.doesNotMatch(text, /99% left/);
  });
});

test("Claude account choices stay disabled until the bound runtime is the current session", async () => {
  const SessionSlot = await loadSessionSlot();
  const session = claudeSession({ ...claudeBound, selection_source: "explicit", applied_runtime_id: "launch-old" });
  await withClaudeSlotDom(async (window, container, root) => {
    await act(async () => {
      root.render(createElement(SessionSlot, makeSessionSlotProps({
        session,
        options: [session],
        accounts: [{ account: "alpha" }, { account: "beta" }],
      })));
    });
    const trigger = container.querySelector<HTMLButtonElement>(".account-status-claude");
    assert.ok(trigger);
    await act(async () => {
      trigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
    assert.ok(dialog);
    assert.match(dialog.textContent ?? "", /Account choices are disabled until the current binding is authoritative/);
    assertNoElement(dialog, '[aria-label="Switch Claude account to beta"]');
  });
});
