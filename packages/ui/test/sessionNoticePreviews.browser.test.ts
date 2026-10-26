import { strict as assert } from "node:assert";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ComponentType } from "react";
import { projectPublicAgentSession } from "@agent-console/shared/api";
import type { MobileSessionListProps } from "../src/MobileSessionList.tsx";
import { makeSession } from "./support/fixtures.ts";
import { createUiSsrHarness, renderComponent } from "./support/ssr.ts";
import { hasHeadlessChrome, measureUiMarkup } from "./support/browserLayout.ts";

const ssr = createUiSsrHarness([{ name: "mock-terminal-pane", enforce: "pre",
  resolveId(source, importer) { return source.endsWith("TerminalPane.tsx") && importer?.includes("/src/") ? "\0terminal-pane-mock" : null; },
  load(id) { return id === "\0terminal-pane-mock" ? 'export function TerminalPane(){return null}' : null; },
}]);
after(async () => ssr.close());
const screenshotDirectory = process.env.AGENT_CONSOLE_UI_SCREENSHOT_DIR;

for (const width of [360, 1440]) {
  test(`notice card previews at ${width}px hide headers and distinguish the user's prompt`, async () => {
    assert.ok(hasHeadlessChrome(), "headless Chrome is required for preview acceptance");
    const { MobileSessionList } = await ssr.loadModule<{ MobileSessionList: ComponentType<MobileSessionListProps> }>("/src/MobileSessionList.tsx");
    const notice = "<!-- agent-notice:v1 kind=mailbox source=fixture -->\n\nSynthetic update\nAdditional details";
    const sessions = [
      { last_prompt: { text: "Genuine prompt" }, last_message: { role: "user", text: notice } },
      { last_prompt: { text: notice } },
    ].map((fields, i) => makeSession({ ...projectPublicAgentSession(fields), id: `sample-${i}`, title: "Synthetic session" }));
    let markup = "";
    for (const cardPreview of ["latest-message", "last-prompt"] as const) {
      markup += renderComponent(MobileSessionList, {
        sessions, cardPreview, machineColors: {}, reachableMachineNames: new Set(), activityDeliveryByMachine: new Map(),
        clockActive: false, resumingKey: null, autoResumePendingKey: null, accountPendingKey: null,
        accountsByProvider: { codex: {}, claude: {} }, initialScrollTop: 0, onScrollTopChange() {}, onOpen() {},
        editingTitleKey: null, beginTitleEdit() {}, saveTitleEdit: async () => {}, cancelTitleEdit() {}, onRetitle() {},
        onNewSession() {}, onResume() {}, onAutoResume: async () => true, onAccount: async () => {},
      });
    }
    const rowsCss = readFileSync(new URL("../src/sessionCardRows.css", import.meta.url), "utf8");
    if (screenshotDirectory) mkdirSync(screenshotDirectory, { recursive: true });
    const metrics = measureUiMarkup<{ previews: string[]; overflow: boolean }>(
      `<style>${rowsCss}.mobile-session-list{height:auto;overflow:visible}</style>${markup}`, width,
      `const result={previews:[...document.querySelectorAll('.mobile-session-card-prompt')].map(el=>el.textContent),overflow:document.documentElement.scrollWidth>innerWidth};
       const style=parent.document.createElement('style');style.textContent='#measurement{display:none}';parent.document.head.append(style);`, false, 1000,
      screenshotDirectory ? [`--window-size=${width + 32},1100`, `--screenshot=${join(screenshotDirectory, `notice-previews-${width}.png`)}`] : [],
    );
    assert.deepEqual(metrics.previews, ["Notice: Synthetic update", "Notice: Synthetic update", "Genuine prompt", "Notice: Synthetic update"]);
    assert.equal(metrics.overflow, false, "cards fit the viewport");
  });
}
