import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { launchPage } from "./support/browserPage.ts";

const fixture = `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import { PhoneConversationPane } from '/src/PhoneConversationPane.tsx';
  import { SessionConversationPane } from '/src/SessionConversationPane.tsx';
  import { LiveConversationPanel } from '/src/LiveConversationPanel.tsx';
  import { makeSession } from '/test/support/fixtures.ts';
  import '/src/styles.css';
  const session = makeSession({
    id: 'sample', machine: 'fixture', agent: 'codex', title: 'Review garden notes',
    session_incarnation: 'sample', provider_resume: { provider: 'codex', session_id: 'sample' },
  });
  const view = new URLSearchParams(location.search).get('view');
  const props = { session, machineReachable: true };
  const Component = view === 'phone' ? PhoneConversationPane :
    view === 'tile' ? SessionConversationPane : LiveConversationPanel;
  createRoot(document.getElementById('root')).render(React.createElement(Component, {
    ...props, swipeEnabled: false, onSwipe() {}, refreshRef: { current: null },
    docked: view === 'dock', showComposer: true, onClose() {},
  }));
`;

// Supply synthetic history and outbox rows at the data boundary. The panes,
// outgoing replies, menu, focus handling and styles are the production code.
const modules: Record<string, string> = {
  "reply-menu-entry": fixture,
  "./useLiveConversation.ts": `
    const conversation = {
      session: { id: 'sample', machine: 'fixture', provider: 'codex' },
      messages: [
        { id: 'sample-1', role: 'user', text: 'Review the garden notes.', timestamp: '2026-01-01T12:00:00' },
        { id: 'sample-2', role: 'assistant', text: 'The draft is ready for review.', timestamp: '2026-01-01T12:01:00' },
      ],
      latestMessagePaging: true, messagesLoaded: true, loading: false,
      viewportRef: { current: null }, open() {}, refreshLatest() {},
    };
    export const useLiveConversation = () => ({ conversation, providerSessionId: 'sample', label: 'Codex' });
  `,
  "./sharedOutboxClient.ts": `
    const items = [
      { id: 'sent', state: 'submitted', text: 'Keep the first two sections in the handout.' },
      { id: 'uncertain', state: 'unknown', text: 'Add a short summary before the final section.' },
    ];
    const rows = [{ key: 'sample', target: { incarnation: 'sample' }, admissions: [], items }];
    const client = {
      targets: () => rows, retainedEdits: () => [], error: () => undefined,
      outgoingItems: row => row.items, submittedProof: () => ({}), isDismissed: () => false,
      canDismiss: (_row, item) => item.state === 'unknown', confirmSubmitted: async () => {},
    };
    export const useSharedOutbox = () => client;
    export const usesSharedOutbox = () => true;
  `,
};

test("outgoing menus fit the conversation views, including at the viewport edge", { timeout: 120_000 }, async t => {
  const bundle = await build({
    configFile: false, logLevel: "silent", resolve: { conditions: ["source"] },
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [react(), {
      name: "reply-menu-fixture",
      enforce: "pre",
      resolveId(id) {
        if (id.endsWith("reply-menu-entry")) return "\0reply-menu-entry";
        if (Object.hasOwn(modules, id)) return "\0" + id;
      },
      load(id) { if (id.startsWith("\0")) return modules[id.slice(1)]; },
    }],
    build: { write: false, target: "esnext", lib: { entry: "reply-menu-entry", formats: ["iife"], name: "Fixture" } },
  });
  const output = Array.isArray(bundle) ? bundle[0] : bundle;
  assert.ok(output && "output" in output);
  const code = output.output.filter(item => item.type === "chunk").map(item => item.code).join("\n");
  const css = output.output.filter(item => item.type === "asset" && item.fileName.endsWith(".css")).map(item => String(item.source)).join("\n");
  const temp = await mkdtemp(join(tmpdir(), "salon-reply-menu-"));
  const evidence = process.env.SALON_UI_EVIDENCE_DIR;
  const file = join(temp, "fixture.html");
  await writeFile(file, `<!doctype html><html data-theme="paper">
    <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>${css}html,body,#root{margin:0;height:100%}#root{display:flex;flex-direction:column}</style>
    <div id="root"></div><script>window.addEventListener("error", event => { document.body.dataset.fixtureError = event.message; });</script><script>${code.replaceAll("</script", "<\\/script")}</script></html>`);
  try {
    const page = await launchPage();
    try {
      const height = 880;
      for (const [view, width] of [
        ["phone", 390], ["phone", 760], ["tile", 761], ["tile", 1280],
        ["overlay", 390], ["overlay", 760], ["overlay", 761], ["overlay", 1099],
        ["dock", 1100], ["dock", 1280],
      ] as const) {
        await page.setViewport(width, height, 1, width <= 760);
        await page.navigate(`${pathToFileURL(file)}?view=${view}`);
        for (const state of ["submitted", "unknown"] as const) {
          const measure = (edge: boolean) => page.evaluate<{
            items: string[]; hittable: boolean; bounds: { left: number; top: number; right: number; bottom: number } | null;
          }>(`(async () => {
            const selector = '[data-status="${state}"] .history-outgoing-bubble';
            let bubble = document.querySelector(selector);
            for (let attempt = 0; !bubble && attempt < 40 && !document.body.dataset.fixtureError; attempt++) {
              await new Promise(resolve => setTimeout(resolve, 25));
              bubble = document.querySelector(selector);
            }
            if (!bubble) throw new Error(document.body.dataset.fixtureError ?? 'The synthetic reply is missing: ' + document.body.innerText);
            if (!${edge}) bubble.focus({ preventScroll: true });
            const box = bubble.getBoundingClientRect();
            bubble.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true,
              clientX: ${edge} ? innerWidth - 1 : Math.round(box.left + 6),
              clientY: ${edge} ? innerHeight - 1 : Math.round(box.bottom - 4) }));
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const menu = document.querySelector('.history-outgoing-menu');
            const items = [...menu?.querySelectorAll('[role="menuitem"]') ?? []];
            return { items: items.map(item => item.textContent),
              bounds: menu?.getBoundingClientRect().toJSON() ?? null,
              hittable: items.every(item => {
                const rect = item.getBoundingClientRect();
                return item.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
              }),
            };
          })()`);
          const visible = await measure(false);
          if (evidence) await writeFile(join(evidence, `${view}-${width}-${state}.png`), await page.screenshot());
          const edge = await measure(true);
          await page.pressEscape();
          await t.test(`${view} ${width} × ${height} ${state}`, () => {
            const expected = state === "unknown" ? ["Copy text", "Dismiss reply"] : ["Copy text"];
            for (const result of [visible, edge]) {
              assert.deepEqual(result.items, expected);
              assert.ok(result.bounds && result.bounds.left >= 0 && result.bounds.top >= 0
                && result.bounds.right <= width && result.bounds.bottom <= height, "the entire menu fits the viewport");
              assert.equal(result.hittable, true, "each action is visible above the conversation");
            }
          });
        }
      }
    } finally { await page.close(); }
  } finally { await rm(temp, { recursive: true, force: true }); }
});
