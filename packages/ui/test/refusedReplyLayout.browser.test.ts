import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import react from "@vitejs/plugin-react";
import { build } from "vite";
import { launchPage } from "./support/browserPage.ts";

interface Measurement {
  readonly composer: number;
  readonly rowTop: number;
  readonly viewportTop: number;
  readonly buttons: { label: string; bottom: number; hit: boolean; coveredByComposer: boolean }[];
}

test("the newest refused reply stays above the composer while following the conversation", async t => {
  const fixture = `
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { PhoneConversationPane } from "/src/PhoneConversationPane.tsx";
    import { SessionSlot } from "/src/SessionSlot.tsx";
    import { LiveConversationPanel } from "/src/LiveConversationPanel.tsx";
    import { makeSession, makeSessionSlotProps } from "/test/support/fixtures.ts";
    import { syncPhoneTier } from "/src/phoneTier.ts";
    import { setItems } from "fixture-outbox";

    const session = makeSession({ id: "sample", machine: "fixture", cwd: "/workspace", repo_name: "sample",
      session_incarnation: "sample-incarnation",
      title: "Sample conversation", provider_resume: { provider: "codex", session_id: "sample-thread" } });
    const editor = () => document.querySelector(".conversation-composer textarea");
    const viewport = () => document.querySelector(".history-messages");
    const afterLayout = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const changeDraft = text => {
      const input = editor();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const waitFor = async condition => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (condition()) return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error("Conversation fixture did not settle");
    };
    const measure = () => {
      const row = viewport().querySelector('[data-status="refused"]');
      return {
        composer: document.querySelector(".conversation-composer").getBoundingClientRect().top,
        rowTop: row.getBoundingClientRect().top,
        viewportTop: viewport().getBoundingClientRect().top,
        buttons: [...row.querySelectorAll(".history-outgoing-actions button")].map(button => {
          const box = button.getBoundingClientRect();
          const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
          return { label: button.textContent, bottom: box.bottom, hit: hit === button,
            coveredByComposer: Boolean(hit?.closest(".conversation-composer")) };
        }),
      };
    };
    window.runRefusedReplyFixture = async view => {
      syncPhoneTier();
      const component = view === "phone" ? PhoneConversationPane : LiveConversationPanel;
      const props = { session, machineReachable: true, swipeEnabled: false, onSwipe() {},
        refreshRef: { current: null }, onClose() {}, showComposer: true, docked: view === "dock" };
      const tile = makeSessionSlotProps({ session, slot: "fixture/sample", options: [session] });
      const content = view === "tile"
        ? React.createElement("ol", { className: "session-workspace desktop mode-2 slots-2" },
          React.createElement(SessionSlot, { ...tile, view: { ...tile.view, sessionListDisplay: "conversation" } }),
          React.createElement(SessionSlot, makeSessionSlotProps({ index: 1, slot: null })))
        : React.createElement(component, props);
      createRoot(document.querySelector("#root")).render(content);
      await waitFor(() => viewport()?.querySelector('[data-history-message-id="message-23"]'));
      const initial = viewport().scrollTop;
      const items = [{ id: "first", text: "Earlier reply", state: "queued" }];
      setItems(items);
      await waitFor(() => viewport().querySelector('[data-status="queued"]'));
      const reply = { id: "newest", text: "/status", state: "queued" };
      setItems([...items, reply]);
      await waitFor(() => viewport().querySelectorAll('[data-status="queued"]').length === 2);
      await afterLayout();
      const ordinary = {
        advanced: viewport().scrollTop > initial,
        bottom: viewport().scrollHeight - viewport().scrollTop - viewport().clientHeight <= 1,
      };

      setItems([...items, { ...reply, state: "refused", error_code: "busy" }]);
      await waitFor(() => viewport().querySelector('[data-status="refused"] .history-outgoing-actions'));
      await afterLayout();
      const refused = measure();

      editor().focus();
      changeDraft("First line\\nSecond line\\nThird line");
      await afterLayout();
      return { ordinary, refused, grown: measure(), viewportWidth: viewport().getBoundingClientRect().width };
    };
    window.resizeWhileReadingOlder = async () => {
      viewport().scrollTop = 0;
      await afterLayout();
      changeDraft("");
      await afterLayout();
      return viewport().scrollTop;
    };
  `;
  const bundled = await build({
    configFile: false,
    logLevel: "silent",
    resolve: { conditions: ["source"] },
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [react(), {
      name: "refused-reply-fixture",
      enforce: "pre",
      resolveId(id) {
        if (id.endsWith("refused-reply-fixture")) return "\0refused-reply-fixture";
        if (id === "fixture-outbox") return "\0fixture-outbox";
        if (id === "./sharedOutboxClient.ts") return "\0fixture-outbox";
        if (id === "./api.ts") return "\0fixture-history";
        if (id === "./resourceEvents.ts") return "\0fixture-resources";
        if (id === "./TerminalPane.tsx") return "\0fixture-terminal";
      },
      load(id) {
        if (id === "\0refused-reply-fixture") return fixture;
        if (id === "\0fixture-outbox") return `
          import { useSyncExternalStore } from "react";
          const listeners = new Set();
          let items = [];
          export function setItems(next) {
            items = next;
            for (const listener of listeners) listener();
          }
          const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };
          const snapshot = () => items;
          const client = {
            targets: session => [{ key: "sample", target: { incarnation: session.session_incarnation }, admissions: [], items }],
            retainedEdits: () => [], submittedProof: () => ({}), outgoingItems: row => row.items,
            isDismissed: () => false, error: () => undefined, confirmSubmitted: async () => {}, canDismiss: () => false,
          };
          export function usesSharedOutbox() { return true; }
          export function useSharedOutbox() { useSyncExternalStore(subscribe, snapshot); return client; }
        `;
        if (id === "\0fixture-history") return `
          export * from "/src/api.ts?original";
          export const listHistorySessions = async machine => ({
            ok: true, latestMessagePaging: true,
            sessions: [{ id: "sample-history", machine, provider: "codex", provider_session_id: "sample-thread" }],
          });
          export const listHistoryMessages = async () => ({
            ok: true, messages: Array.from({ length: 24 }, (_, index) => ({
              id: "message-" + index, role: index % 2 ? "assistant" : "user", text: "Sample history message " + (index + 1),
            })),
          });
        `;
        if (id === "\0fixture-resources") return `
          export const RESOURCE_RECONCILE_MS = 30000;
          export const resourceEvents = { subscribe() { return () => {}; } };
        `;
        if (id === "\0fixture-terminal") return 'export function TerminalPane() { throw Error("Fixture opened a terminal"); }';
      },
    }],
    build: { write: false, minify: false, lib: { entry: "refused-reply-fixture", name: "RefusedReplyFixture", formats: ["iife"] } },
  });
  const output = Array.isArray(bundled) ? bundled[0] : bundled;
  assert.ok(output && "output" in output);
  const code = output.output.filter(item => item.type === "chunk").map(item => item.code).join("\n");
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const markup = `<style>${css} html,body{margin:0}#root{display:flex;height:100vh}</style><div id="root"></div>`;
  const evidence = process.env.AGENT_CONSOLE_UI_SCREENSHOT_DIR;
  const page = await launchPage();
  try {
    for (const [view, width] of [
      ["phone", 384], ["phone", 760], ["drawer", 761], ["drawer", 1099], ["dock", 1100], ["tile", 1440],
    ] as const) {
      const height = view === "tile" ? 900 : 832;
      await t.test(`${view} at ${width}×${height}`, async () => {
        await page.setViewport(width, height, 1);
        await page.navigate("about:blank");
        await page.evaluate(`document.body.innerHTML = ${JSON.stringify(markup)}`);
        await page.evaluate(code);
        const result = await page.evaluate<{ ordinary: { advanced: boolean; bottom: boolean }; refused: Measurement; grown: Measurement; viewportWidth: number }>(
          `window.runRefusedReplyFixture("${view}")`);
        if (evidence) writeFileSync(join(evidence, `${view}-${width}.png`), await page.screenshot());
        if (view === "tile") assert.ok(result.viewportWidth <= width / 2, "the conversation occupies one grid column");
        assert.deepEqual(result.ordinary, { advanced: true, bottom: true }, "ordinary replies still follow the bottom");
        assert.ok(result.grown.composer < result.refused.composer, "multiline draft expands the composer");
        for (const [stage, measured] of [["refusal", result.refused], ["composer growth", result.grown]] as const) {
          assert.deepEqual(measured.buttons.map(button => button.label).sort(), ["Discard", "Retry"]);
          assert.ok(measured.rowTop >= measured.viewportTop, `${stage}: the top of the refused row is visible`);
          assert.ok(measured.buttons.every(button => button.bottom <= measured.composer && button.hit),
            `${stage}: both actions are above the composer and hit-testable: ${JSON.stringify(measured)}`);
        }
        assert.equal(await page.evaluate("window.resizeWhileReadingOlder()"), 0, "resizing preserves the reader's position in older messages");
      });
    }
  } finally {
    await page.close();
  }
});
