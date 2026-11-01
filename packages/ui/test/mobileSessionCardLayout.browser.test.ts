import { createBadgeSsrHarness as createUiSsrHarness } from "./support/neutralBadges.ts";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ComponentType } from "react";
import type { Plugin } from "vite";
import type { MobileSessionListProps } from "../src/MobileSessionList.tsx";
import type { DashboardSession } from "../src/types.ts";
import { makeSession } from "./support/fixtures.ts";
import { makeSessionSlotProps } from "./support/fixtures.ts";
import { hasHeadlessChrome, measureUiMarkup, phoneTierScript } from "./support/browserLayout.ts";
import { renderComponent } from "./support/ssr.ts";

const chrome = process.env.CHROME_BIN ?? "google-chrome";
const screenshotDirectory = process.env.AGENT_CONSOLE_UI_SCREENSHOT_DIR;
const ssr = createUiSsrHarness([mockTerminalPanePlugin()]);
after(async () => ssr.close());

for (const width of [360]) {
  for (const scheme of ["dark", "light"]) {
    test(`${width}px ${scheme} preference: card prompt previews reserve and clamp five lines`, async (t) => {
      if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
      const prompts = ["One short line", Array.from({ length: 8 }, (_, i) => `Prompt line ${i + 1}`).join("\n"), ""];
      const sessions = prompts.map((text, i) => makeSession({
        id: `prompt-${i}`, title: ["Short prompt", "Long prompt", "Empty prompt"][i],
        last_prompt: { text, truncated: false },
      }));
      const { MobileSessionList } = await ssr.loadModule<{ MobileSessionList: ComponentType<MobileSessionListProps> }>("/src/MobileSessionList.tsx");
      const body = renderComponent(MobileSessionList, {
        sessions, options: sessions, machineColors: {}, reachableMachineNames: new Set(["summit"]),
        activityDeliveryByMachine: new Map(), clockActive: false, resumingKey: null,
        autoResumePendingKey: null, accountPendingKey: null, accountsByProvider: { codex: {}, claude: {} },
        initialScrollTop: 0, onScrollTopChange() {}, onOpen() {}, editingTitleKey: null,
        beginTitleEdit() {}, saveTitleEdit: async () => {}, cancelTitleEdit() {}, onRetitle() {},
        onNewSession() {}, onSelectSession() {}, onResume() {}, onAutoResume: async () => true,
        onAccount: async () => {},
      });
      const rowsCss = readFileSync(new URL("../src/sessionCardRows.css", import.meta.url), "utf8");
      const markup = `<style>${rowsCss}html,body{margin:0}body{padding-top:var(--ac-safe-area-top)}.mobile-session-list{height:auto;overflow:visible}.session-workspace{height:500px}</style>${body}`;
      const metrics = measureUiMarkup<{
        boxes: Array<{ height: number; lineHeight: number; clamp: string; overflow: string; textOverflow: string; visibleLines: number; text: string }>;
        cardHeights: number[];
        colorScheme: string;
      }>(markup, width, `
        const captureStyle = parent.document.createElement('style');
        captureStyle.textContent = '#measurement{display:none}'; parent.document.head.append(captureStyle);
        const boxes = [...document.querySelectorAll('.mobile-session-card-prompt')].map(box => {
          const rect = box.getBoundingClientRect(), css = getComputedStyle(box);
          const range = document.createRange(); range.selectNodeContents(box);
          const visibleTops = new Set([...range.getClientRects()].filter(line =>
            line.width > 0 && (line.top + line.bottom) / 2 >= rect.top && (line.top + line.bottom) / 2 < rect.bottom
          ).map(line => Math.round(line.top * 10) / 10));
          return {height:rect.height,lineHeight:parseFloat(css.lineHeight),clamp:css.webkitLineClamp,
            overflow:css.overflow,textOverflow:css.textOverflow,visibleLines:visibleTops.size,text:box.textContent};
        });
        const result = {boxes,colorScheme:matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
          cardHeights:[...document.querySelectorAll('.mobile-session-card,.terminal-slot')].map(card => card.getBoundingClientRect().height)};
      `, false, 1000, [
        // Blink PreferredColorScheme: dark=0, light=1. Set both explicitly so
        // the light case never inherits the host desktop's dark preference.
        `--blink-settings=preferredColorScheme=${scheme === "dark" ? 0 : 1}`,
        ...(screenshotDirectory ? [
          `--window-size=${width + 16},1000`,
          `--screenshot=${join(screenshotDirectory, `prompt-preview-${width}-${scheme}.png`)}`,
        ] : []),
      ]);
      assert.equal(metrics.boxes.length, 3, "short, long and empty prompts all reserve a box");
      assert.equal(metrics.colorScheme, scheme, "browser uses the requested color-scheme preference");
      assert.equal(metrics.cardHeights.length, 3);
      for (const box of metrics.boxes) {
        assert.ok(Math.abs(box.height - 5 * box.lineHeight) <= 0.1, "preview height equals five computed lines");
        assert.equal(box.clamp, "5");
        assert.equal(box.overflow, "hidden");
        assert.equal(box.textOverflow, "ellipsis");
        assert.ok(Math.abs(box.height - metrics.boxes[0]!.height) <= 0.1, "all preview heights match");
      }
      assert.equal(metrics.boxes[0]!.visibleLines, 1, JSON.stringify(metrics.boxes));
      assert.equal(metrics.boxes[1]!.visibleLines, 5, "eight-line prompt exposes exactly five rendered lines");
      assert.equal(metrics.boxes[1]!.text, prompts[1], "clipping preserves the full underlying prompt");
      assert.equal(metrics.boxes[2]!.text, "No prompt yet — Open session");
      for (const height of metrics.cardHeights) assert.ok(Math.abs(height - metrics.cardHeights[0]!) <= 0.1, "all card heights match");
    });
  }
}

function mockTerminalPanePlugin(): Plugin {
  const mockId = "\0terminal-pane-mock";
  return {
    name: "mock-terminal-pane",
    enforce: "pre",
    resolveId(source, importer) {
      return source.endsWith("TerminalPane.tsx") && importer?.includes("/src/") ? mockId : null;
    },
    load(id) {
      return id === mockId ? `import React from "react"; export function TerminalPane() { return React.createElement("div"); }` : null;
    },
  };
}

test("mobile session card layout stays aligned in headless Chrome at phone widths", async (t) => {
  const probe = spawnSync(chrome, ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    t.skip(`headless Chrome is unavailable (${chrome})`);
    return;
  }

  const component = await ssr.loadModule<{ MobileSessionList: ComponentType<MobileSessionListProps> }>("/src/MobileSessionList.tsx");
  const now = new Date().toISOString();
  const turnState = (phase: "working" | "waiting", outcome?: "completed" | "failed") => ({
    schema_version: "agent-session.turn-state.v1" as const,
    phase,
    phase_changed_at: now,
    revision: 1,
    source: { kind: "provider_hook" as const, provider: "codex" as const, confidence: "authoritative" as const },
    ...(phase === "working" ? { semantic_event: { kind: "progress" as const, observed_at: now } } : {}),
    current_turn: { started_at: now },
    ...(phase === "waiting" ? { last_turn: { completed_at: now, outcome: outcome ?? "interrupted" as const } } : {}),
  });
  const sessions = [
    makeSession({ id: "working-role", repo_name: "summit-infra-with-a-long-project-name", agent: "claude", model: "a-very-long-model-name-that-must-truncate-first", reasoning_effort: "high", turn_state: turnState("working"), coordinator_tree: { depth: 0 }, claude_account: { schema_version: "agent-session.claude-account.v1", supported: true, state: "bound", selected_account: "alpha", selection_source: "default_at_launch", revision: 1, applied_runtime_id: "launch-1" } }),
    makeSession({ id: "waiting", repo_name: "symphony-board-with-a-long-repository-name", model: "another-very-long-model-name-for-this-header", turn_state: turnState("waiting") }),
    makeSession({ id: "completed", turn_state: turnState("waiting", "completed") }),
    makeSession({ id: "blocked", turn_state: turnState("waiting", "failed") }),
    makeSession({ id: "unknown", machine: "offline", turn_state: { schema_version: "agent-session.turn-state.v1", phase: "unknown", phase_changed_at: now, revision: 1, source: { kind: "runtime", confidence: "observed" } } }),
  ] as DashboardSession[];
  const body = renderComponent(component.MobileSessionList, {
    sessions, options: sessions, editingTitleKey: null,
    beginTitleEdit: () => {}, saveTitleEdit: async () => {}, cancelTitleEdit: () => {},
    onRetitle: () => {}, onNewSession: () => {}, onSelectSession: () => {},
    machineColors: {}, reachableMachineNames: new Set(["summit"]), activityDeliveryByMachine: new Map(),
    clockActive: false, resumingKey: null, autoResumePendingKey: null, accountPendingKey: null,
    accountsByProvider: { codex: {}, claude: { summit: { accounts: [{ account: "alpha" }] } } }, initialScrollTop: 0, onScrollTopChange: () => {},
    onOpen: () => {}, onResume: () => {}, onAutoResume: async () => true, onAccount: async () => {},
  });
  const css = `${readFileSync(join(process.cwd(), "src/styles.css"), "utf8")}\n${readFileSync(join(process.cwd(), "src/sessionCardRows.css"), "utf8")}`;
  const temp = mkdtempSync(join(tmpdir(), "agent-console-card-layout-"));
  try {
    for (const width of [360, 384, 412]) {
      const htmlPath = join(temp, `layout-${width}.html`);
      const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style>${phoneTierScript}<style>html,body{margin:0}body{font-family:system-ui,sans-serif}.capture{width:${width}px}.mobile-session-list{height:800px}</style><main class="capture">${body}</main><script>const result=[...document.querySelectorAll('.mobile-session-card')].map(card=>{const toolbar=card.querySelector('.mobile-session-card-toolbar');const meta=card.querySelector('.mobile-session-card-meta');const rowOne=card.querySelector('.mobile-session-card-row-one');const rowTwo=card.querySelector('.mobile-session-card-row-two');const title=card.querySelector('.mobile-session-card-title').getBoundingClientRect();const status=card.querySelector('.mobile-session-card-status');const repo=card.querySelector('.repo-badge');const repoLine=repo.querySelector('.repo-badge-line');const model=card.querySelector('.session-model-name');const marker=card.querySelector('.session-activity-marker').getBoundingClientRect();const dot=card.querySelector('.card-status-icon').getBoundingClientRect();const bounds=toolbar.getBoundingClientRect();const statusRect=status.getBoundingClientRect();return {toolbarWidth:bounds.width,toolbarRight:bounds.right,statusRight:statusRect.right,rowTwoChildrenCount:rowTwo.children.length,repoLines:repo.querySelectorAll('.repo-badge-line').length,repoHeight:repo.getBoundingClientRect().height,repoLineHeight:repoLine.getBoundingClientRect().height,repoWhiteSpace:getComputedStyle(repoLine).whiteSpace,repoOverflow:getComputedStyle(repoLine).textOverflow,repoTitle:repo.getAttribute('title'),modelWidth:model?.clientWidth,modelScrollWidth:model?.scrollWidth,modelOverflow:model?getComputedStyle(model).textOverflow:null,dotCenter:[(dot.left+dot.right)/2,(dot.top+dot.bottom)/2],ringCenter:[(marker.left+marker.right)/2,(marker.top+marker.bottom)/2],rowOneTop:rowOne.getBoundingClientRect().top,rowOneBottom:rowOne.getBoundingClientRect().bottom,metaTop:meta.getBoundingClientRect().top,titleTop:title.top,titleBottom:title.bottom,statusTop:statusRect.top,statusBottom:statusRect.bottom,rowTwoTop:rowTwo.getBoundingClientRect().top,rowTwoBottom:rowTwo.getBoundingClientRect().bottom,rowTwoRight:rowTwo.getBoundingClientRect().right}});document.body.dataset.layout=btoa(JSON.stringify({width:${width},cards:result}));</script>`;
      writeFileSync(htmlPath, html);
      const result = spawnSync(chrome, ["--headless", "--disable-gpu", "--no-sandbox", "--hide-scrollbars", "--force-device-scale-factor=2.8", "--window-size=500,900", "--dump-dom", `file://${htmlPath}`], { encoding: "utf8", timeout: 15_000 });
      assert.equal(result.status, 0, `Chrome failed at ${width}px: ${result.stderr}`);
      const encoded = result.stdout.match(/data-layout="([^"]+)"/)?.[1];
      assert.ok(encoded, `Chrome did not return layout metrics at ${width}px`);
      const metrics = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as {
        width: number;
        cards: Array<{ toolbarWidth: number; toolbarRight: number; statusRight: number; rowTwoChildrenCount: number; repoLines: number; repoHeight: number; repoLineHeight: number; repoWhiteSpace: string; repoOverflow: string; repoTitle: string | null; modelWidth: number | undefined; modelScrollWidth: number | undefined; modelOverflow: string | null; dotCenter: [number, number]; ringCenter: [number, number]; rowOneTop: number; rowOneBottom: number; metaTop: number; titleTop: number; titleBottom: number; statusTop: number; statusBottom: number; rowTwoTop: number; rowTwoBottom: number; rowTwoRight: number }>;
      };
      assert.equal(metrics.width, width);
      assert.equal(metrics.cards.length, sessions.length);
      if (screenshotDirectory) {
        mkdirSync(screenshotDirectory, { recursive: true });
        const screenshotPath = join(screenshotDirectory, `session-card-${width}.png`);
        const screenshot = spawnSync(chrome, ["--headless", "--disable-gpu", "--no-sandbox", "--hide-scrollbars", `--window-size=${width},900`, `--screenshot=${screenshotPath}`, `file://${htmlPath}`], { encoding: "utf8", timeout: 15_000 });
        assert.equal(screenshot.status, 0, `Chrome screenshot failed at ${width}px: ${screenshot.stderr}`);
      }
      for (const [index, card] of metrics.cards.entries()) {
        assert.ok(card.metaTop >= card.rowOneTop - 0.5 && card.titleBottom <= card.rowOneBottom + 0.5, `${width}px card ${index} puts repository, role and title in row one`);
        assert.ok(card.rowTwoTop >= card.rowOneBottom - 0.5, `${width}px card ${index} puts the harness row below the identity row`);
        assert.ok(card.statusTop >= card.rowTwoTop - 0.5 && card.statusBottom <= card.rowTwoBottom + 0.5, `${width}px card ${index} puts the status in row two`);
        assert.ok(card.rowTwoChildrenCount >= 4, `${width}px card ${index} keeps provider, account, model and status in row two`);
        assert.ok(card.statusRight <= card.toolbarRight + 0.5, `${width}px card ${index} status row stays inside the toolbar`);
        assert.equal(card.repoLines, 1, `${width}px card ${index} repo chip line count`);
        assert.ok(card.repoHeight > 0 && card.repoLineHeight > 0, `${width}px card ${index} repo chip should render`);
        assert.equal(card.repoWhiteSpace, "nowrap", `${width}px card ${index} repo label stays on one line`);
        assert.equal(card.repoOverflow, "ellipsis", `${width}px card ${index} repo label truncates visually`);
        assert.ok(card.repoTitle, `${width}px card ${index} retains the full repo label as a tooltip`);
        if (width === 360 && index < 2) {
          assert.ok((card.modelScrollWidth ?? 0) > (card.modelWidth ?? 0), `${width}px fixture ${index} model text is truncated first`);
          assert.equal(card.modelOverflow, "ellipsis", `${width}px fixture ${index} model shows an ellipsis`);
        }
        assert.ok(Math.abs(card.dotCenter[0] - card.ringCenter[0]) <= 0.5, `${width}px card ${index} dot x center`);
        assert.ok(Math.abs(card.dotCenter[1] - card.ringCenter[1]) <= 0.5, `${width}px card ${index} dot y center`);
      }
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("desktop session card keeps both metadata rows visible at narrow widths", async (t) => {
  const probe = spawnSync(chrome, ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    t.skip(`headless Chrome is unavailable (${chrome})`);
    return;
  }

  const component = await ssr.loadModule<{ SessionSlot: ComponentType<import("../src/SessionSlot.tsx").SessionSlotProps> }>("/src/SessionSlot.tsx");
  const session = makeSession({
    machine: "fixture",
    role: "reviewer",
    title: "A long desktop session title that must ellipsize before the identity-row action buttons",
    provider_resume: { provider: "codex", session_id: "fixture-provider-id" },
    model: "desktop-example-model",
    reasoning_effort: "high",
    title_mode: "auto",
    display_revision: 1,
    codex_account: {
      schema_version: "agent-session.codex-account.v1",
      supported: true,
      state: "unbound",
      revision: 0,
    },
  });
  const body = renderComponent(component.SessionSlot, makeSessionSlotProps({ session, options: [session] }));
  assert.match(body, /class="account-usage-root"/, "the desktop fixture renders an account badge");
  const css = `${readFileSync(join(process.cwd(), "src/styles.css"), "utf8")}\n${readFileSync(join(process.cwd(), "src/sessionCardRows.css"), "utf8")}`;
  const temp = mkdtempSync(join(tmpdir(), "agent-console-desktop-card-layout-"));
  try {
    const widths = [320, 360, 412, 920, 1200];
    for (const width of widths) {
      const htmlPath = join(temp, `desktop-card-${width}.html`);
      const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style>${phoneTierScript}<style>html,body{margin:0}body{font-family:system-ui,sans-serif}.capture{width:${width}px}.session-workspace{display:block;height:auto;overflow:visible}.terminal-slot{width:${width}px;min-width:0}</style><main class="capture"><ol class="session-workspace">${body}</ol></main><script>try {const card=document.querySelector('.terminal-slot').getBoundingClientRect();const one=document.querySelector('.slot-session-card-row-one').getBoundingClientRect();const two=document.querySelector('.slot-session-card-row-two').getBoundingClientRect();const status=document.querySelector('.session-activity-root').getBoundingClientRect();const accountRoot=document.querySelector('.account-usage-root');const popover=document.createElement('span');popover.className='account-usage-popover is-pinned';popover.setAttribute('role','dialog');popover.textContent='Account actions';accountRoot.append(popover);const popoverRect=popover.getBoundingClientRect();const activityRoot=document.querySelector('.session-activity-root');const activityPopover=document.createElement('span');activityPopover.className='session-activity-popover is-preview';activityPopover.textContent='Working for 1m';activityRoot.append(activityPopover);const activityRect=activityPopover.getBoundingClientRect();const children=[...document.querySelector('.slot-session-card-row-two').children].map(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}});const firstRowControls=[".repo-badge-link",".fixture-marker",".slot-title-menu",".session-command-copy-button",".slot-open",".slot-action.danger"].map(selector=>{const r=document.querySelector(selector)?.getBoundingClientRect();return {selector,left:r?.left??0,right:r?.right??0,top:r?.top??0,bottom:r?.bottom??0,width:r?.width??0}});const title=document.querySelector(".slot-title-label"),titleStyle=getComputedStyle(title);document.body.dataset.layout=btoa(JSON.stringify({firstRowControls,titleOverflow:titleStyle.textOverflow,titleRight:title.getBoundingClientRect().right,copyLeft:document.querySelector(".session-command-copy-button").getBoundingClientRect().left,oneBottom:one.bottom,cardLeft:card.left,cardRight:card.right,oneTop:one.top,twoTop:two.top,twoBottom:two.bottom,oneRight:one.right,statusRight:status.right,statusTop:status.top,statusBottom:status.bottom,popoverLeft:popoverRect.left,popoverRight:popoverRect.right,popoverTop:popoverRect.top,popoverBottom:popoverRect.bottom,activityPopoverLeft:activityRect.left,activityPopoverRight:activityRect.right,children}))}catch(error){document.body.dataset.layoutError=String(error)}</script>`;
      writeFileSync(htmlPath, html);
      const result = spawnSync(chrome, ["--headless", "--disable-gpu", "--no-sandbox", "--hide-scrollbars", `--window-size=${Math.max(width, 1024)},700`, "--dump-dom", `file://${htmlPath}`], { encoding: "utf8", timeout: 15_000 });
      assert.equal(result.status, 0, `Chrome failed to render the ${width}px desktop card: ${result.stderr}`);
      const error = result.stdout.match(/data-layout-error="([^\"]+)"/)?.[1];
      assert.equal(error, undefined, `desktop measurement script completes: ${error}`);
      const encoded = result.stdout.match(/data-layout="([^"]+)"/)?.[1];
      assert.ok(encoded, `Chrome should return ${width}px desktop card layout metrics`);
      const metrics = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as { cardLeft: number; cardRight: number; oneTop: number; twoTop: number; oneRight: number; statusRight: number; statusTop: number; statusBottom: number; twoBottom: number; popoverLeft: number; popoverRight: number; activityPopoverLeft: number; activityPopoverRight: number; popoverTop: number; popoverBottom: number; children: Array<{ left: number; right: number; top: number; bottom: number }>; firstRowControls: Array<{ selector: string; left: number; right: number; top: number; bottom: number; width: number }>; oneBottom: number; titleOverflow: string; titleRight: number; copyLeft: number };
      for (const control of metrics.firstRowControls) {
        assert.ok(control.width > 0 && control.left >= metrics.cardLeft - 1 && control.right <= metrics.cardRight + 1
          && control.top >= metrics.oneTop - 1 && control.bottom <= metrics.oneBottom + 1,
        `${width}px desktop row one shows ${control.selector}`);
      }
      assert.equal(metrics.titleOverflow, "ellipsis", `${width}px long desktop title retains visual truncation`);
      assert.ok(metrics.titleRight <= metrics.copyLeft + 1, `${width}px title stops before fixed actions`);
      assert.ok(metrics.twoTop > metrics.oneTop, `${width}px desktop account/model metadata is in row two`);
      assert.ok(metrics.statusTop >= metrics.twoTop - 1 && metrics.statusBottom <= metrics.twoBottom + 1, `${width}px desktop status pill sits in row two`);
      assert.ok(metrics.children.every((child) => child.left >= metrics.cardLeft - 1 && child.right <= metrics.cardRight + 1), `${width}px desktop row-two controls stay inside the card horizontally`);
      assert.ok(metrics.children.every((child) => child.bottom > child.top), `${width}px desktop row-two controls remain visible`);
      assert.ok(metrics.popoverLeft >= metrics.cardLeft - 1, `${width}px account popover stays within the card's left edge`);
      assert.ok(metrics.popoverRight <= metrics.cardRight + 1, `${width}px account popover stays within the card's right edge`);
      assert.ok(metrics.popoverBottom > metrics.popoverTop, `${width}px pinned account popover remains visible`);
      assert.ok(metrics.activityPopoverLeft >= metrics.cardLeft - 1, `${width}px activity popover stays within the card's left edge`);
      assert.ok(metrics.activityPopoverRight <= metrics.cardRight + 1, `${width}px activity popover stays within the card's right edge`);
      if (screenshotDirectory && (width === 412 || width === 1200)) {
        mkdirSync(screenshotDirectory, { recursive: true });
        const screenshotPath = join(screenshotDirectory, `session-card-desktop-${width}.png`);
        const screenshot = spawnSync(chrome, ["--headless", "--disable-gpu", "--no-sandbox", "--hide-scrollbars", `--window-size=${Math.max(width, 1024)},700`, `--screenshot=${screenshotPath}`, `file://${htmlPath}`], { encoding: "utf8", timeout: 15_000 });
        assert.equal(screenshot.status, 0, `Chrome desktop screenshot failed: ${screenshot.stderr}`);
      }
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("phone focused header lays out identity and harness rows at 320, 360, 384 and 412px", async (t) => {
  const probe = spawnSync(chrome, ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    t.skip(`headless Chrome is unavailable (${chrome})`);
    return;
  }

  const component = await ssr.loadModule<{ SessionSlot: ComponentType<import("../src/SessionSlot.tsx").SessionSlotProps> }>("/src/SessionSlot.tsx");
  const session = makeSession({
    agent: "codex",
    title: "A long focused session title that has to share row one with Back and the actions",
    repo_name: "agent-console",
    role: "reviewer",
    model: "a-very-long-model-name-that-must-truncate-first",
    reasoning_effort: "high",
    title_mode: "pinned",
    display_revision: 1,
    provider_resume: { provider: "codex", session_id: "codex-provider-id" },
    turn_state: {
      schema_version: "agent-session.turn-state.v1", phase: "working", phase_changed_at: "2026-07-06T00:00:00Z", revision: 1,
      source: { kind: "provider_hook", provider: "codex", confidence: "authoritative" },
      semantic_event: { kind: "progress", observed_at: "2026-07-06T00:00:30Z" }, current_turn: { started_at: "2026-07-06T00:00:00Z" },
    },
    codex_account: { schema_version: "agent-session.codex-account.v1", supported: true, state: "bound", selected_account: "account-a", revision: 1, applied_runtime_id: "launch-1" },
  });
  const body = renderComponent(component.SessionSlot, makeSessionSlotProps({
    session, options: [session], accounts: [{ account: "account-a" }], focused: true, focusedKey: "summit:hs-1",
    sessionOrdinal: 2, sessionCount: 3, viewport: { mobile: true },
  } as never));
  const css = `${readFileSync(join(process.cwd(), "src/styles.css"), "utf8")}\n${readFileSync(join(process.cwd(), "src/sessionCardRows.css"), "utf8")}`;
  const temp = mkdtempSync(join(tmpdir(), "agent-console-focused-header-"));
  try {
    for (const width of [320, 360, 384, 412]) {
      const htmlPath = join(temp, `focused-header-${width}.html`);
      const script = `const box=sel=>{const el=document.querySelector(sel);if(!el)return null;const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width}};
        const one=box('.slot-focus-row-one'),two=box('.slot-focus-row-two');
        const inRow=(row,sel)=>{const b=box(sel);return !!row&&!!b&&b.width>0&&b.top>=row.top-1&&b.bottom<=row.bottom+1&&b.left>=-1&&b.right<=${width}+1};
        parent.document.body.dataset.layout=btoa(JSON.stringify({one,two,viewportWidth:innerWidth,
          rowOne:['.slot-back','.repo-badge','.fixture-marker','.slot-title','.session-command-copy-button','.slot-action.danger'].map(sel=>[sel,inRow(one,sel)]),
          rowTwo:['.agent-retitle-button','.account-status','.session-model-badge','.auto-resume-status','.session-activity-trigger','.session-activity-text','.slot-session-nav'].map(sel=>[sel,inRow(two,sel)]),
          overflow:[...document.querySelectorAll('.slot-head *')].some(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.right>${width}+1}),
          label:/(^|[^-\\w])(Auto|Pinned)(?![-\\w])/.test(document.querySelector('main').textContent)}));`;
      // Chrome clamps its outer window width. An iframe gives the fixed focused
      // slot and responsive CSS the exact requested phone viewport.
      const frameHtml = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style>${phoneTierScript}<style>html,body{margin:0}body{font-family:system-ui,sans-serif}.session-workspace{display:block;height:auto;overflow:visible}</style><main><ol class="session-workspace mobile is-focused">${body}</ol></main><script>${script}</script>`;
      const html = `<!doctype html><style>html,body{margin:0}</style><body><script>const frame=document.createElement('iframe');frame.style.cssText='display:block;border:0;width:${width}px;height:300px';frame.srcdoc=${JSON.stringify(frameHtml).replaceAll("<", "\\u003c")};document.body.append(frame);</script>`;
      writeFileSync(htmlPath, html);
      const result = spawnSync(chrome, ["--headless", "--disable-gpu", "--no-sandbox", "--hide-scrollbars", `--window-size=${width},700`, "--virtual-time-budget=3000", "--dump-dom", `file://${htmlPath}`], { encoding: "utf8", timeout: 15_000 });
      assert.equal(result.status, 0, `Chrome failed: ${result.stderr}`);
      const encoded = result.stdout.match(/data-layout="([^"]+)"/)?.[1];
      assert.ok(encoded, "Chrome should return focused header metrics");
      const metrics = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as {
        one: { top: number; bottom: number } | null; two: { top: number; bottom: number } | null;
        rowOne: Array<[string, boolean]>; rowTwo: Array<[string, boolean]>; overflow: boolean; label: boolean; viewportWidth: number;
      };
      if (screenshotDirectory) {
        mkdirSync(screenshotDirectory, { recursive: true });
        const screenshot = spawnSync(chrome, ["--headless", "--disable-gpu", "--no-sandbox", "--hide-scrollbars", `--window-size=${width},300`, "--virtual-time-budget=3000", `--screenshot=${join(screenshotDirectory, `focused-header-${width}.png`)}`, `file://${htmlPath}`], { encoding: "utf8", timeout: 15_000 });
        assert.equal(screenshot.status, 0, `Chrome screenshot failed: ${screenshot.stderr}`);
      }
      assert.ok(metrics.one && metrics.two, "both header rows render");
      assert.equal(metrics.viewportWidth, width, "responsive CSS uses the requested viewport");
      assert.ok(metrics.two.top >= metrics.one.bottom - 1, "the harness row sits below the identity row");
      for (const [selector, inside] of metrics.rowOne) assert.ok(inside, `${width}px row one shows ${selector}`);
      for (const [selector, inside] of metrics.rowTwo) assert.ok(inside, `${width}px row two shows ${selector}: ${JSON.stringify(metrics)}`);
      assert.equal(metrics.overflow, false, `${width}px header does not scroll sideways`);
      assert.equal(metrics.label, false, "no title-mode label renders");
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("phone title menu keeps visible hit targets inside the card at 360 and 384px", async (t) => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const { MobileSessionList } = await ssr.loadModule<{ MobileSessionList: ComponentType<MobileSessionListProps> }>("/src/MobileSessionList.tsx");
  const sessions = [makeSession({ coordinator_tree: { depth: 0 }, repo_name: "a-long-repository-name", model: "example-model", reasoning_effort: "high" })];
  const body = renderComponent(MobileSessionList, {
    sessions, options: sessions, editingTitleKey: null,
    beginTitleEdit: () => {}, saveTitleEdit: async () => {}, cancelTitleEdit: () => {},
    onRetitle: () => {}, onNewSession: () => {}, onSelectSession: () => {},
    machineColors: {}, reachableMachineNames: new Set(["summit"]), activityDeliveryByMachine: new Map(), clockActive: false,
    resumingKey: null, autoResumePendingKey: null, accountPendingKey: null, accountsByProvider: { codex: {}, claude: {} },
    initialScrollTop: 0, onScrollTopChange: () => {}, onOpen: () => {}, onResume: () => {}, onAutoResume: async () => true, onAccount: async () => {},
  });
  const rowsCss = readFileSync(join(process.cwd(), "src/sessionCardRows.css"), "utf8");
  for (const width of [360, 384]) {
    const metrics = measureUiMarkup<{ repoRight: number; roleLeft: number; menuLeft: number; menuRight: number; cardRight: number; menuHit: boolean; overflow: string }>(
      `<style>${rowsCss}html,body{margin:0}.mobile-session-list{height:800px}</style>${body}`,
      width,
      `const card=document.querySelector('.mobile-session-card');
       const repo=card.querySelector('.repo-badge').getBoundingClientRect();
       const role=card.querySelector('.fixture-marker').getBoundingClientRect();
       card.querySelector('details').open=true;
       const menu=card.querySelector('.slot-title-dropdown'), r=menu.getBoundingClientRect();
       const item=menu.querySelector('button'), b=item.getBoundingClientRect();
       const result={repoRight:repo.right,roleLeft:role.left,menuLeft:r.left,menuRight:r.right,cardRight:card.getBoundingClientRect().right,
         menuHit:item.contains(document.elementFromPoint((b.left+b.right)/2,(b.top+b.bottom)/2)),overflow:getComputedStyle(card).overflow};`,
    );
    assert.ok(metrics.repoRight <= metrics.roleLeft, `${width}px repository and role hit targets do not overlap`);
    assert.ok(metrics.menuLeft >= 0 && metrics.menuRight <= metrics.cardRight, `${width}px dropdown stays within the card`);
    assert.equal(metrics.overflow, "visible", `${width}px card does not clip the new menu`);
    assert.equal(metrics.menuHit, true, `${width}px menu item receives the hit outside the header`);
  }
});
