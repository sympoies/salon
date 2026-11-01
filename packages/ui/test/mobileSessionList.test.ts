import { createBadgeSsrHarness as createUiSsrHarness } from "./support/neutralBadges.ts";
import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import type { ComponentType } from "react";
import { Window } from "happy-dom";
import type { Plugin } from "vite";
import type { MobileSessionListProps } from "../src/MobileSessionList.tsx";
import { applySessionListResult } from "../src/dashboardSessions.ts";
import type { DashboardSession, Session } from "../src/types.ts";
import { makeSession } from "./support/fixtures.ts";
import { assertNoElement } from "./support/domAssert.ts";
import { sessionKey } from "../src/layout.ts";
import { renderComponent } from "./support/ssr.ts";
import { makeCssRuleLookup, uiSource, uiStyles } from "./support/source.ts";

const mobileSource = uiSource("MobileSessionList.tsx");
const dashboardSource = uiSource("Dashboard.tsx");
const cssRuleFor = makeCssRuleLookup(`${uiStyles()}\n${uiSource("sessionCardRows.css")}`);
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
      if (id !== mockId) return null;
      return `
        import React from "react";
        export function TerminalPane() {
          return React.createElement("div", { className: "terminal-pane-mock" });
        }
      `;
    },
  };
}

after(async () => ssr.close());

function reconcileMobileSession(previous: Session, incoming: Session): DashboardSession {
  return applySessionListResult({
    ok: true,
    sessions: [incoming],
    machines: [{ name: "summit", ok: true }],
  }, {
    sessionsRef: { current: [previous] },
    reachableMachineNamesRef: { current: new Set(["summit"]) },
    knownMachineNamesRef: { current: new Set(["summit"]) },
    setSessions: () => {},
    setReachableMachineNames: () => {},
    setError: () => {},
  }).sessions[0]!;
}

async function renderMobileSessions(
  sessions: readonly DashboardSession[],
  resumingKey: string | null = null,
  cardPreview: "latest-message" | "last-prompt" = "latest-message",
): Promise<string> {
  const module = await ssr.loadModule<{
    MobileSessionList: ComponentType<MobileSessionListProps>;
  }>("/src/MobileSessionList.tsx");
  return renderComponent(module.MobileSessionList, {
    sessions, options: sessions, cardPreview, editingTitleKey: null,
    beginTitleEdit: () => {}, saveTitleEdit: async () => {}, cancelTitleEdit: () => {},
    onRetitle: () => {}, onNewSession: () => {}, onSelectSession: () => {},
    machineColors: {},
    reachableMachineNames: new Set(["summit"]),
    activityDeliveryByMachine: new Map(),
    clockActive: false,
    resumingKey,
    autoResumePendingKey: null,
    accountPendingKey: null,
    accountsByProvider: { codex: {}, claude: {} },
    initialScrollTop: 0,
    onScrollTopChange: () => {},
    onOpen: () => {},
    onResume: () => {},
    onAutoResume: async () => true,
    onAccount: async () => {},
  });
}

test("MobileSessionList badge is keyed on the session's agent", () => {
  // Regression guard: mobile cards must pick the same mark as SessionSlot, or the
  // badge silently diverges on mobile (it did before this guard existed). Both
  // key the mark on the agent alone, so a profile-specific variant here is
  // exactly the divergence to catch.
  const badgeBlock = mobileSource.slice(
    mobileSource.indexOf("<AgentBadge"),
    mobileSource.indexOf("/>", mobileSource.indexOf("<AgentBadge")),
  );
  assert.ok(badgeBlock.length > 0, "expected an AgentBadge element in MobileSessionList");
  assert.match(badgeBlock, /agent=\{session\.agent\}/);
  assert.doesNotMatch(badgeBlock, /agent_profile/);
});

test("MobileSessionList renders the given order without an attention re-sort", () => {
  // Cross-device consistency: the overview must render sessions in the same
  // shared ⌘-nav / picker / macOS order it is handed, not re-group them by
  // attention tier (which diverged from the picker and desktop). The old
  // attention-sort model is gone.
  assert.doesNotMatch(mobileSource, /sortSessionsByAttention/);
  assert.doesNotMatch(mobileSource, /mobileSessionListModel/);
  assert.match(mobileSource, /\{sessions\.map\(\(session\)/);
  // Dashboard feeds only the current page after applying the shared stable
  // order; MobileSessionList remains a passive renderer with no local re-sort.
  assert.match(dashboardSource, /<MobileSessionList\s+sessions=\{overviewPageSessions\}/);
});

test("MobileSessionList does not render a visible host chip", () => {
  assert.doesNotMatch(mobileSource, /primaryMachine/);
  assert.doesNotMatch(mobileSource, /SessionHostChip/);
});

test("MobileSessionList renders repository names with the shared badge", () => {
  assert.match(
    mobileSource,
    /import \{ AutoResumeBadge, RepoBadgeLink \} from "\.\/SessionSlot\.tsx";/,
  );
  assert.match(
    mobileSource,
    /<RepoBadgeLink\s+label=\{sessionRepoLabel\(session\)\}\s+session=\{session\}\s+machineColors=\{machineColors\}\s+singleLine\s+\/>/,
  );
  assert.doesNotMatch(mobileSource, /mobile-session-card-repo/);
});

test("MobileSessionList reuses the shared account popover and Dashboard mutation authority", () => {
  assert.match(mobileSource, /import \{ SessionAccountBadge \} from "\.\/SessionAccountBadge\.tsx";/);
  assert.match(mobileSource, /readonly accountsByProvider: AccountInventoriesByProvider/);
  assert.match(mobileSource, /readonly accountPendingKey: string \| null/);
  assert.match(mobileSource, /readonly onAccount: \(session: Session, account: string\) => Promise<void>/);
  assert.match(mobileSource, /<SessionAccountBadge[\s\S]*session=\{session\}/);
  assert.match(dashboardSource, /<MobileSessionList[\s\S]*accountsByProvider=\{accountsByProvider\}/);
  assert.match(dashboardSource, /<MobileSessionList[\s\S]*accountPendingKey=\{accountPendingKey\}/);
  assert.match(dashboardSource, /<MobileSessionList[\s\S]*onAccount=\{onAccount\}/);
});

test("MobileSessionList mounts no terminal (overview is status-only)", () => {
  // The mobile overview must never mount a live terminal; only the focused
  // fullscreen session runs one (see Dashboard's mobile focus branch).
  assert.doesNotMatch(mobileSource, /TerminalPane/);
});

test("MobileSessionList presents a resumable stopped session as recovery", async () => {
  const session = makeSession({ status: "stopped", resumable: true });
  const html = await renderMobileSessions([session]);

  assert.match(html, new RegExp(`aria-label="Recover ${session.title}"`));
  assert.match(html, />Recover<\/button>/);
  assert.doesNotMatch(html, />Resume<\/button>/);

  const pendingHtml = await renderMobileSessions([session], sessionKey(session));
  assert.match(pendingHtml, /disabled=""/);
  assert.match(pendingHtml, />Recovering…<\/button>/);
  assert.doesNotMatch(pendingHtml, /Resuming…/);
});

test("mobile cards ignore legacy orchestration metadata", async () => {
  const standalone = makeSession({ id: "standalone" });
  const main = makeSession({
    id: "main",
    orchestration: {
      schema_version: "agent-session.session-orchestration.v1",
      run_id: "cf750754-cde1-4307-b953-a38e115da802",
      role: "main",
      relationship_revision: 1,
      run_state: "active",
      objective_summary: "Deliver shared labels",
    },
  });
  const html = await renderMobileSessions([standalone, main]);

  assert.doesNotMatch(html, />Standalone</);
  assert.doesNotMatch(html, /orchestration-strip|Main Agent/);
});

test("mounted mobile cards retain only a same-runtime pending prompt", async () => {
  const current = makeSession({
    agent: "claude",
    session_incarnation: "same-runtime",
    runtime_started_at: "2026-07-22T12:00:00Z",
    last_prompt_continuity: "a".repeat(32),
    last_prompt_state: "current",
    last_prompt: { text: "Keep this mounted prompt", truncated: false },
  });
  const pending = reconcileMobileSession(current, {
    ...current,
    last_prompt_state: "pending",
    last_prompt: undefined,
  });
  const pendingHtml = await renderMobileSessions([pending]);
  assert.match(
    pendingHtml,
    /class="mobile-session-card-prompt">Keep this mounted prompt<\/span>/,
  );

  const unavailable = reconcileMobileSession(pending, {
    ...pending,
    last_prompt_state: "unavailable",
    last_prompt: undefined,
  });
  const unavailableHtml = await renderMobileSessions([unavailable]);
  assert.match(unavailableHtml, /class="mobile-session-card-prompt" aria-hidden="true">No prompt yet — Open session<\/span>/);
  assert.doesNotMatch(unavailableHtml, /Keep this mounted prompt/);
});

test("mounted mobile cards shorten the legacy voice prompt note", async () => {
  const html = await renderMobileSessions([makeSession({
    agent: "claude",
    last_prompt: {
      text: "以下文字由語音轉寫，可能有同音字或專有名詞錯誤。請依對話脈絡理解；檔名、路徑、指令、數字或可能修改資料的內容若有歧義，先向我確認。 原始轉寫： 已經 commit 了",
      truncated: false,
    },
  })]);
  assert.match(html, /class="mobile-session-card-prompt">\[語音\] 已經 commit 了<\/span>/);
  assert.doesNotMatch(html, /語音轉寫/);
});

test("mobile session cards show a quoted voice prompt without its quote markers", async () => {
  const html = await renderMobileSessions([makeSession({
    agent: "claude",
    last_prompt: { text: "typed text > [語音·Fast] 已經 commit 了 > 第二行", truncated: false },
  })]);
  assert.match(html, /class="mobile-session-card-prompt">typed text \[語音·Fast\] 已經 commit 了 &gt; 第二行<\/span>/);
});

test("status pill and auto-resume sit with the harness metadata in row two", () => {
  assert.match(mobileSource, /mobile-session-card-status/);
  assert.match(mobileSource, /mobile-session-card-row-two[\s\S]*AutoResumeBadge[\s\S]*SessionActivityPopover/);
});

test("MobileSessionList receives the shared auto-resume mutation state", () => {
  assert.match(mobileSource, /readonly autoResumePendingKey: string \| null/);
  assert.match(mobileSource, /readonly onAutoResume: \(session: Session, enabled: boolean\) => Promise<boolean>/);
  assert.match(mobileSource, /pending=\{autoResumePendingKey === key\}/);
  assert.match(mobileSource, /onToggle=\{\(enabled\) => onAutoResume\(session, enabled\)\}/);
  assert.match(dashboardSource, /<MobileSessionList[\s\S]*autoResumePendingKey=\{autoResumePendingKey\}/);
  assert.match(dashboardSource, /<MobileSessionList[\s\S]*onAutoResume=\{onAutoResume\}/);
});

test("title sits in the identity row and the prompt spans the card below both rows", () => {
  assert.match(cssRuleFor(".mobile-session-card-head"), /flex-direction:\s*column/);
  assert.match(cssRuleFor(".mobile-session-card-toolbar"), /display:\s*flex/);
  assert.match(cssRuleFor(".mobile-session-card-toolbar"), /flex-direction:\s*column/);
  assert.match(cssRuleFor(".mobile-session-card-toolbar"), /background:\s*var\(--surface-toolbar\)/);
  assert.match(cssRuleFor(".mobile-session-card-open"), /flex:\s*1 1 0/);
  assert.match(cssRuleFor(".mobile-session-card-prompt-open"), /width:\s*100%/);
  assert.match(
    mobileSource,
    /mobile-session-card-toolbar[\s\S]*mobile-session-card-row-one[\s\S]*SessionTitleMenu[\s\S]*mobile-session-card-row-two[\s\S]*mobile-session-card-prompt-open/,
  );
});

test("mobile session cards keep content height so the status foot is never clipped", () => {
  // The list is a scrollable flex column. Without flex:none the cards inherit the
  // default flex-shrink:1 and get compressed to fit when the list overflows, and
  // each card's overflow:hidden then clips its last child — the activity/status
  // foot (worst on 2-line titles). flex:none keeps every card at content height
  // and lets the list scroll instead of shrinking cards.
  assert.match(cssRuleFor(".mobile-session-card"), /flex: none;/);
});

function managedWorker(overrides: Partial<Session> = {}): DashboardSession {
  return makeSession({
    id: "worker",
    agent: "codex",
    title: "Render each worker's own task",
    orchestration: {
      schema_version: "agent-session.session-orchestration.v1",
      run_id: "cf750754-cde1-4307-b953-a38e115da802",
      role: "worker",
      assignment_id: "assignment-1",
      assignment_state: "working",
      primary_manager: {
        session_id: "main",
        session_incarnation: "inc-main",
        session_created_at: "2026-07-22T12:00:00Z",
      },
      relationship_revision: 1,
      run_state: "active",
      objective_summary: "Ship the run view follow-ups",
      task_summary: "Render each worker's own task",
    },
    ...overrides,
  });
}

test("stored generated launch prompts remain suppressed after retirement", async () => {
  const withheld = await renderMobileSessions([managedWorker({ last_prompt_state: "current" })]);
  assert.match(withheld, /class="mobile-session-card-prompt" aria-hidden="true">No prompt yet — Open session<\/span>/);

  const bootstrap = await renderMobileSessions([managedWorker({
    last_prompt_state: "current",
    last_prompt: {
      text: "Main Agent Mode is explicitly active for this managed worker assignment. Run exactly `/opt/nils-cli/bin/main-agent bootstrap --idempotency-key bootstrap-1a2b3c4d --format json` now.",
      truncated: false,
    },
  })]);
  assert.match(bootstrap, /class="mobile-session-card-prompt" aria-hidden="true">No prompt yet — Open session<\/span>/);
  assert.doesNotMatch(bootstrap, /main-agent|\/opt\/nils-cli/);
});

test("MobileSessionList shows the Claude account badge for a bound Claude session", async () => {
  const module = await ssr.loadModule<{
    MobileSessionList: ComponentType<MobileSessionListProps>;
  }>("/src/MobileSessionList.tsx");
  const session = makeSession({
    agent: "claude",
    claude_account: {
      schema_version: "agent-session.claude-account.v1",
      supported: true,
      state: "bound",
      selected_account: "alpha",
      selection_source: "default_at_launch",
      revision: 1,
      applied_runtime_id: "launch-hs-1",
    },
  });
  const html = renderComponent(module.MobileSessionList, {
    sessions: [session],
    machineColors: {},
    reachableMachineNames: new Set(["summit"]),
    activityDeliveryByMachine: new Map(),
    clockActive: false,
    resumingKey: null,
    autoResumePendingKey: null,
    accountPendingKey: null,
    accountsByProvider: { codex: {}, claude: { summit: { accounts: [{ account: "alpha" }, { account: "beta" }] } } },
    initialScrollTop: 0,
    onScrollTopChange: () => {},
    onOpen: () => {},
    onResume: () => {},
    onAutoResume: async () => true,
    onAccount: async () => {},
  });
  assert.match(html, /account-status-claude/);
  assert.match(html, />default · alpha<\/button>/);
  assert.doesNotMatch(renderComponent(module.MobileSessionList, {
    sessions: [makeSession({ agent: "claude" })],
    machineColors: {},
    reachableMachineNames: new Set(["summit"]),
    activityDeliveryByMachine: new Map(),
    clockActive: false,
    resumingKey: null,
    autoResumePendingKey: null,
    accountPendingKey: null,
    accountsByProvider: { codex: {}, claude: {} },
    initialScrollTop: 0,
    onScrollTopChange: () => {},
    onOpen: () => {},
    onResume: () => {},
    onAutoResume: async () => true,
    onAccount: async () => {},
  }), /account-status-claude/);
});

test("MobileSessionList places the control marker inside the existing meta row", async () => {
  const control = makeSession({ id: "control-1", repo_name: "control", coordinator_tree: { depth: 0 } }) as DashboardSession;
  const plain = makeSession({ id: "plain", repo_name: "agent-console" }) as DashboardSession;
  const html = await renderMobileSessions([control, plain]);
  assert.match(html, /<span class="mobile-session-card-meta">(?:(?!mobile-session-card-status).)*fixture-marker/s);
  assert.equal(html.match(/fixture-marker--/g)?.length, 1);
});


test("mobile session cards show model and effort beside account metadata", async () => {
  const html = await renderMobileSessions([makeSession({ model: "example-model", reasoning_effort: "medium" })]);
  assert.match(html, /example-model · medium/);
});

test("mobile card headers keep one repo line and two consistent toolbar rows at phone widths", async () => {
  const now = new Date().toISOString();
  const turnState = (phase: "working" | "waiting", outcome?: "completed" | "failed") => ({
    schema_version: "agent-session.turn-state.v1" as const,
    phase,
    phase_changed_at: now,
    revision: 1,
    source: { kind: "provider_hook" as const, provider: "codex", confidence: "authoritative" as const },
    ...(phase === "working"
      ? { semantic_event: { kind: "progress" as const, observed_at: now } }
      : {}),
    current_turn: { started_at: now },
    ...(phase === "waiting"
      ? { last_turn: { completed_at: outcome ? now : new Date(Date.now() - 60_000).toISOString(), outcome: outcome ?? "interrupted" as const } }
      : {}),
  });
  const sessions = [
    makeSession({
      id: "long-repo-role-working",
      repo_name: "summit-infra",
      agent: "claude",
      model: "a-very-long-model-name-that-must-truncate-first",
      reasoning_effort: "high",
      turn_state: turnState("working"),
      claude_account: {
        schema_version: "agent-session.claude-account.v1",
        supported: true,
        state: "bound",
        selected_account: "alpha",
        selection_source: "default_at_launch",
        revision: 1,
        applied_runtime_id: "launch-hs-1",
      },
      coordinator_tree: { depth: 0 },
    }),
    makeSession({
      id: "long-repo-waiting",
      repo_name: "symphony-board",
      model: "another-very-long-model-name-for-the-responsive-card-header",
      reasoning_effort: "medium",
      turn_state: turnState("waiting"),
    }),
    makeSession({
      id: "completed",
      turn_state: turnState("waiting", "completed"),
    }),
    makeSession({
      id: "blocked",
      turn_state: turnState("waiting", "failed"),
    }),
    makeSession({
      id: "unknown",
      machine: "offline",
      turn_state: { schema_version: "agent-session.turn-state.v1", phase: "unknown", phase_changed_at: now, revision: 1, source: { kind: "runtime", confidence: "observed" } },
    }),
  ] as DashboardSession[];
  const expectedStates = ["working", "waiting", "completed", "blocked", "unknown"];

  for (const viewportWidth of [360, 412]) {
    const window = new Window({ url: "http://localhost" });
    window.happyDOM.setWindowSize({ width: viewportWidth, height: 800 });
    window.document.body.innerHTML = await renderMobileSessions(sessions);
    const cards = [...window.document.querySelectorAll<HTMLElement>(".mobile-session-card")];
    assert.equal(cards.length, sessions.length);

    for (const card of cards) {
      const toolbar = card.querySelector<HTMLElement>(".mobile-session-card-toolbar");
      assert.ok(toolbar);
      assert.deepEqual([...toolbar.children].map((child) => child.className), [
        "mobile-session-card-row-one",
        "mobile-session-card-row-two",
      ], `${viewportWidth}px header should have an identity row and a harness row`);
      const rowOne = toolbar.children[0] as HTMLElement;
      const rowTwo = toolbar.children[1] as HTMLElement;
      assertNoElement(rowOne, ".session-host-chip", `${viewportWidth}px row 1 omits the session host chip`);
      assert.ok(rowOne.querySelector(".mobile-session-card-title"), `${viewportWidth}px row 1 shows the title`);
      assert.ok(rowTwo.querySelector(".mobile-session-card-status .session-activity-trigger"), `${viewportWidth}px row 2 shows the status pill`);
      assert.ok(rowTwo.querySelector(".session-model-badge"), `${viewportWidth}px row 2 shows model and effort`);
      assert.doesNotMatch(rowTwo.textContent ?? "", /ctx\s*\d+%/i, `${viewportWidth}px cards omit unsupported context percentages`);
      const repo = card.querySelector<HTMLElement>(".repo-badge");
      assert.ok(repo);
      assert.equal(repo.querySelectorAll(".repo-badge-line").length, 1, `${viewportWidth}px repo chip must stay on one line`);
      assert.equal(repo.getAttribute("title"), repo.getAttribute("aria-label"));
      assert.equal(card.querySelectorAll(".mobile-session-card-status > *").length >= 1, true);
    }

    assert.equal(cards[0]?.querySelector(".fixture-marker") !== null, true, "first card has the role marker");
    assert.equal(cards[1]?.querySelector(".fixture-marker") !== null, false, "second card has no role marker");
    for (let index = 0; index < expectedStates.length; index += 1) {
      assert.ok(
        cards[index]?.querySelector(`.card-state-${expectedStates[index]}`),
        `${viewportWidth}px fixture ${index} should render the ${expectedStates[index]} status variant; got ${cards[index]?.querySelector(".session-activity-trigger")?.className}`,
      );
    }
    window.happyDOM.abort();
  }

  const toolbarRule = cssRuleFor(".mobile-session-card-toolbar");
  assert.match(toolbarRule, /display:\s*flex/);
  assert.match(toolbarRule, /flex-direction:\s*column/);
  assert.match(cssRuleFor(".mobile-session-card-row-two"), /flex-wrap:\s*nowrap/);
  assert.match(cssRuleFor(".mobile-session-card-status"), /flex-wrap:\s*nowrap/);
  assert.match(cssRuleFor(".mobile-session-card-row-two .session-model-badge"), /text-overflow:\s*ellipsis/);
  assert.match(cssRuleFor(".mobile-session-card-row-two .session-model-badge"), /white-space:\s*nowrap/);
  assert.match(cssRuleFor(".mobile-session-card-row-two .session-model-badge"), /display:\s*block/);
  assert.match(cssRuleFor(".session-activity-marker"), /display:\s*grid/);
  assert.match(cssRuleFor(".session-activity-marker"), /width:\s*14px/);
  assert.match(cssRuleFor(".session-activity-marker"), /height:\s*14px/);
  assert.match(uiStyles(), /--card-status-icon-size:\s*14px/);
  assert.match(cssRuleFor(".card-status-icon"), /display:\s*block/);
  assert.match(cssRuleFor(".card-status-icon"), /width:\s*var\(--card-status-icon-size\)/);
  assert.match(cssRuleFor(".card-status-icon"), /height:\s*var\(--card-status-icon-size\)/);
  assert.match(uiSource("CardStatusIcon.tsx"), /<circle cx="12" cy="12" r="6"/);
});


test("card previews choose either side, mark assistant replies and preserve prompt fallback", async () => {
  const item = makeSession({last_prompt: {text: "Review the change"}, last_message: {role: "assistant", text: "The change is ready"}});
  const preview = async (session: Session, mode: "latest-message" | "last-prompt") => {
    const window = new Window();
    window.document.body.innerHTML = await renderMobileSessions([session], null, mode);
    const text = window.document.querySelector(".mobile-session-card-prompt")?.textContent;
    await window.happyDOM.close();
    return text;
  };
  assert.equal(await preview(item, "latest-message"), "Agent: The change is ready");
  assert.equal(await preview(item, "last-prompt"), "Review the change");
  assert.equal(await preview({...item, last_message: {role: "user", text: "A newer prompt"}}, "latest-message"), "A newer prompt");
  assert.equal(await preview({...item, last_message: undefined}, "latest-message"), "Review the change");
  const pending = reconcileMobileSession({...item, last_prompt_state: "current", last_prompt_continuity: "fixture-epoch"},
    {...item, last_prompt: undefined, last_prompt_state: "pending", last_prompt_continuity: "fixture-epoch"});
  assert.equal(await preview(pending, "last-prompt"), "Review the change", "pending prompt continuity still applies");
});

test("mobile session cards show an upload path as a short chip label", async () => {
  const html = await renderMobileSessions([makeSession({
    agent: "claude",
    last_prompt: { text: "'/state/sessions/s-1/attachments/shot.png' check it", truncated: false },
  })]);
  assert.match(html, /class="mobile-session-card-prompt">\[Image shot\.png\] check it<\/span>/);
  assert.doesNotMatch(html, /\/state\/sessions/);
});
