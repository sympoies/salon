import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import type { Plugin } from "vite";
import { hasHeadlessChrome, measureUiMarkup } from "./support/browserLayout.ts";
import { createUiSsrHarness } from "./support/ssr.ts";

const running = { schema_version: "agent-session.shell.v1", owner: "alice", status: "running", incarnation: "shell-one", tmux_name: "ac-shell-alice" };
const stopped = { ...running, status: "stopped", incarnation: null };

/** Mount the real page; only transport and the xterm renderer are replaced. */
async function renderShell(shell: typeof running | typeof stopped): Promise<string> {
  Object.assign(globalThis, { __shellLayoutRead: async () => shell });
  const plugin: Plugin = { name: "shell-layout-fixture", enforce: "pre", resolveId(source, importer) {
    if (!importer?.endsWith("/ShellPage.tsx")) return null;
    return source === "./api.ts" ? "\0shell-layout-api" : source === "./TerminalPane.tsx" ? "\0shell-layout-terminal" : null;
  }, load(id) {
    if (id === "\0shell-layout-api") return "export const readEmergencyShell = (...args) => globalThis.__shellLayoutRead(...args);";
    if (id === "\0shell-layout-terminal") return 'import {createElement} from "react"; export const TerminalPane = () => createElement("div", {className: "terminal-pane with-key-bar"}, createElement("div", {className: "term-host"}));';
    return null;
  } };
  const harness = createUiSsrHarness([plugin]);
  const { ShellPage } = await harness.loadModule<{ ShellPage: ComponentType<{ machines: string[]; onExit(): void }> }>("/src/ShellPage.tsx");
  const window = new Window({ url: "http://localhost" });
  const keys = ["window", "document", "HTMLElement", "Element", "IS_REACT_ACT_ENVIRONMENT"];
  const previous = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element, IS_REACT_ACT_ENVIRONMENT: true });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(ShellPage, { machines: ["example-machine", "second-machine"], onExit() {} })));
    return container.innerHTML;
  } finally {
    await act(async () => root.unmount());
    await harness.close();
    keys.forEach((key, index) => previous[index] ? Object.defineProperty(globalThis, key, previous[index]!) : Reflect.deleteProperty(globalThis, key));
    Reflect.deleteProperty(globalThis, "__shellLayoutRead");
    await window.happyDOM.close();
  }
}

interface Box { readonly top: number; readonly bottom: number; readonly left: number; readonly right: number; readonly lines?: number }
interface Measurement {
  readonly back: Box; readonly title: Box; readonly machine: Box; readonly actions: Box[]; readonly status: Box;
  readonly host: Box | null; readonly overflow: boolean; readonly outside: string[];
}

function measure(markup: string, width: number): Measurement {
  return measureUiMarkup<Measurement>(`<div style="height:640px;display:flex;flex-direction:column">${markup}</div>`, width, `
    const box = el => { const r = el.getBoundingClientRect(); return {top:r.top, bottom:r.bottom, left:r.left, right:r.right}; };
    const lines = el => { const range = document.createRange(); range.selectNodeContents(el); return new Set([...range.getClientRects()].map(r => Math.round(r.top))).size; };
    const header = document.querySelector('.shell-page-header');
    const controls = [...header.querySelectorAll('button, select')];
    const host = document.querySelector('.term-host');
    const result = {
      back: box(header.querySelector('button')), title: box(header.querySelector('h1')),
      machine: box(header.querySelector('select')),
      actions: [...header.querySelectorAll('.shell-page-actions button')].map(el => ({...box(el), lines: lines(el)})),
      status: box(document.querySelector('.shell-page-status')),
      host: host ? box(host) : null,
      overflow: document.documentElement.scrollWidth > innerWidth,
      outside: controls.filter(el => { const r = el.getBoundingClientRect(); return r.left < 0 || r.right > innerWidth; }).map(el => el.textContent || el.getAttribute('aria-label')),
    };
  `);
}

const TIERS = [360, 390, 412, 480, 600, 768, 1024, 1280];

for (const width of TIERS) {
  test(`${width}px Shell header stays on tidy rows and the terminal has equal side insets`, async (t) => {
    if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
    const m = measure(await renderShell(running), width);
    const mid = (box: Box) => (box.top + box.bottom) / 2;
    assert.equal(m.overflow, false, "page does not scroll horizontally");
    assert.deepEqual(m.outside, [], "every header control stays inside the viewport");
    assert.ok(Math.abs(mid(m.back) - mid(m.title)) < 4, "Back and the title share the first row");
    assert.equal(m.actions.length, 2);
    for (const action of m.actions) assert.equal(action.lines, 1, "action labels never wrap");
    assert.ok(Math.abs(m.actions[0]!.top - m.actions[1]!.top) < 1, "actions stay together on one row");
    assert.ok(Math.abs(mid(m.machine) - mid(m.actions[0]!)) < 4, "machine selector and actions share one balanced row");
    if (width < 640) assert.ok(m.machine.top >= m.back.bottom, "narrow screens use a second row for the machine selector and actions");
    else assert.ok(Math.abs(mid(m.machine) - mid(m.back)) < 4, "wide screens use a single header row");
    assert.ok(m.status.top >= m.machine.bottom - 1, "status row follows the header");
    assert.ok(m.host, "terminal host is mounted");
    const left = m.host!.left, right = width - m.host!.right;
    assert.ok(Math.abs(left - right) < 0.5, `terminal insets are equal (${left}px left, ${right}px right)`);
    assert.ok(left >= 6, `terminal text keeps a visible inset (${left}px)`);
  });
}

test("stopped Shell keeps a single tidy Open Shell action at phone width", async (t) => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const m = measure(await renderShell(stopped), 360);
  assert.equal(m.actions.length, 1);
  assert.equal(m.actions[0]!.lines, 1);
  assert.ok(m.actions[0]!.right <= 360 && m.machine.top >= m.back.bottom);
});
