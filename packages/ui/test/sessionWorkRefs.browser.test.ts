import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ComponentType } from "react";
import { createBadgeSsrHarness } from "./support/neutralBadges.ts";
import { makeSession, makeSessionSlotProps } from "./support/fixtures.ts";
import { hasHeadlessChrome, measureUiMarkup } from "./support/browserLayout.ts";
import { renderComponent } from "./support/ssr.ts";
import type { MobileSessionListProps } from "../src/MobileSessionList.tsx";
import type { SessionSlotProps } from "../src/SessionSlot.tsx";

const ssr = createBadgeSsrHarness([{ name: "mock-terminal", enforce: "pre", resolveId(source, importer) { return source.endsWith("TerminalPane.tsx") && importer?.includes("/src/") ? "\0terminal-mock" : null; }, load(id) { return id === "\0terminal-mock" ? `import React from "react"; export function TerminalPane() { return React.createElement("div"); }` : null; } }]);
after(async () => ssr.close());
const work = { program: { provider: "github", repository: "example/plan", number: 1 }, issues: [{ provider: "github", repository: "example/project", number: 42 }], inherited: false };

test("work references appear on phone and desktop cards without overflow", async t => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const { MobileSessionList } = await ssr.loadModule<{ MobileSessionList: ComponentType<MobileSessionListProps> }>("/src/MobileSessionList.tsx");
  const { SessionSlot } = await ssr.loadModule<{ SessionSlot: ComponentType<SessionSlotProps> }>("/src/SessionSlot.tsx");
  const session = makeSession({ title: "Review changes", repo_name: "project", work });
  const mobile = renderComponent(MobileSessionList, { sessions: [session], options: [session], machineColors: {}, reachableMachineNames: new Set(["summit"]), activityDeliveryByMachine: new Map(), clockActive: false, resumingKey: null, autoResumePendingKey: null, accountPendingKey: null, accountsByProvider: { codex: {}, claude: {} }, initialScrollTop: 0, onScrollTopChange() {}, onOpen() {}, editingTitleKey: null, beginTitleEdit() {}, saveTitleEdit: async () => {}, cancelTitleEdit() {}, onRetitle() {}, onNewSession() {}, onSelectSession() {}, onResume() {}, onAutoResume: async () => true, onAccount: async () => {} });
  const desktop = renderComponent(SessionSlot, makeSessionSlotProps({ session, options: [session] }));
  const css = `${readFileSync("src/styles.css", "utf8")}\n${readFileSync("src/sessionCardRows.css", "utf8")}`;
  for (const [width, body] of [[384, mobile], [1280, `<ol class="session-workspace desktop">${desktop}</ol>`]] as const) {
    const markup = `<style>${css} html,body{margin:0} .mobile-session-list,.session-workspace{height:auto;overflow:visible}</style>${body}`;
    const metrics = measureUiMarkup<{ labels: string[]; contained: boolean }>(markup, width, `const refs=[...document.querySelectorAll('.session-work-refs a')]; const card=document.querySelector('.mobile-session-card,.terminal-slot').getBoundingClientRect(); const result={labels:refs.map(a=>a.textContent),contained:refs.every(a=>{const r=a.getBoundingClientRect(); return r.width>0 && r.left>=card.left-1 && r.right<=card.right+1})};`);
    assert.deepEqual(metrics.labels, ["plan#1", "project#42"]);
    assert.equal(metrics.contained, true, `${width}px links remain within the card`);
    const directory = process.env.SESSION_WORK_REFS_CAPTURE_DIR;
    if (directory) {
      const temp = mkdtempSync(join(tmpdir(), "salon-work-refs-"));
      try {
        const html = join(temp, "capture.html");
        writeFileSync(html, `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">${markup}`);
        const capture = spawnSync(process.env.CHROME_BIN ?? "google-chrome", ["--headless", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", `--window-size=${width},720`, `--screenshot=${join(directory, `work-refs-${width}.png`)}`, `file://${html}`], { encoding: "utf8", timeout: 15000 });
        assert.equal(capture.status, 0, capture.stderr);
      } finally { rmSync(temp, { recursive: true, force: true }); }
    }
  }
});
