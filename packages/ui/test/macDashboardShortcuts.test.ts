import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Plugin } from "vite";
import { createUiSsrHarness } from "./support/ssr.ts";
import { makeSession } from "./support/fixtures.ts";

const SESSIONS = Array.from({ length: 8 }, (_, index) => makeSession({ id: `s${index + 1}`, machine: "fixture", title: `Work ${index + 1}` }));

const boundary: Plugin = {
  name: "mac-shortcut-boundaries", enforce: "pre",
  resolveId(id, importer) {
    if (importer?.includes("/src/") && id.endsWith("TerminalPane.tsx")) return "\0mac-shortcut-terminal";
  },
  load(id) {
    if (id === "\0mac-shortcut-terminal") return `import React from "react"; export function TerminalPane(){return React.createElement("div",{className:"terminal-pane"});}`;
  },
  transform(code, id) {
    if (!id.endsWith("/src/api.ts")) return;
    for (const name of ["listSessions", "usage", "fetchLayoutOrder", "listAccounts"])
      code = code.replace(`export async function ${name}(`, `export async function original${name}(`);
    return `${code}
      export const listSessions = async () => ({ok:true,sessions:${JSON.stringify(SESSIONS)},machines:[{name:"fixture",ok:true}]});
      export const usage = async () => ({providers:[],reachable:false});
      export const fetchLayoutOrder = async () => ({order:[],revision:null,reachable:false,conflict:false});
      export const listAccounts = async () => ({accounts:[]});
    `;
  },
};

async function mountDashboard(macTauri = true) {
  const window = new Window({ url: "http://localhost" });
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
  if (macTauri) Object.assign(window, { __TAURI_INTERNALS__: {} });
  const names = ["window", "document", "Element", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "Event", "MouseEvent", "KeyboardEvent", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = Object.fromEntries(names.map((name) => [name, globalThis[name]]));
  Object.assign(globalThis, {
    window, document: window.document, Element: window.Element, HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement, HTMLTextAreaElement: window.HTMLTextAreaElement,
    HTMLSelectElement: window.HTMLSelectElement, Event: window.Event, MouseEvent: window.MouseEvent,
    KeyboardEvent: window.KeyboardEvent, localStorage: window.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  const ssr = createUiSsrHarness([boundary]);
  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => root.render(createElement(Dashboard, {
    active: true, machines: ["fixture"], enabledMachines: ["fixture"], machineColors: {}, defaultAutoResume: false,
    terminalRenderMode: "realtime", terminalSelectedPaneRealtime: true, onDebug() {}, onUsage() {}, onSettings() {},
  } as never)));
  const settle = async (condition: () => boolean, label: string) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (condition()) return;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    }
    assert.fail(`${label}; body: ${container.textContent?.slice(0, 300)}`);
  };
  const press = async (init: { key: string; code: string; shiftKey?: boolean }, target: EventTarget = window.document.body) => {
    await act(async () => {
      target.dispatchEvent(new window.KeyboardEvent("keydown", { metaKey: true, bubbles: true, cancelable: true, ...init }) as unknown as Event);
    });
  };
  const pageLabel = () => container.querySelector(".session-list-page-label")?.textContent ?? null;
  const focusedSlot = () => container.querySelector<HTMLElement>(".terminal-slot.is-focused")?.dataset.slotKey ?? null;
  await settle(() => pageLabel() === "1 / 2", "the two-page list did not render");
  return {
    window, container, press, settle, pageLabel, focusedSlot,
    async close() {
      await act(async () => root.unmount());
      await ssr.close();
      Object.assign(globalThis, previous);
      await window.happyDOM.close();
    },
  };
}

const NEXT = { key: ".", code: "Period" };
const PREVIOUS = { key: ",", code: "Comma" };

test("Command-Period and Command-Comma move the list pager like its arrows, also from the reply composer", async () => {
  const h = await mountDashboard();
  try {
    await h.press(NEXT);
    await h.settle(() => h.pageLabel() === "2 / 2", "Command-Period did not show the next page");
    await h.press(PREVIOUS);
    await h.settle(() => h.pageLabel() === "1 / 2", "Command-Comma did not show the previous page");
    const composer = h.window.document.createElement("textarea");
    h.container.append(composer);
    await h.press(NEXT, composer);
    await h.settle(() => h.pageLabel() === "2 / 2", "Command-Period did nothing from the reply composer");
    await h.press({ key: ">", code: "Period", shiftKey: true });
    assert.equal(h.pageLabel(), "2 / 2");
  } finally { await h.close(); }
});

test("Command-Period and Command-Comma move a focused session view across list pages and keep the list in step", async () => {
  const h = await mountDashboard();
  try {
    await h.press({ key: "2", code: "Digit2" });
    await h.settle(() => h.focusedSlot() !== null, "Command-2 did not focus a session");
    const pageOneSession = h.focusedSlot()!;
    assert.match(pageOneSession, /s2$/);

    await h.press(NEXT);
    await h.settle(() => /s5$/.test(h.focusedSlot() ?? ""), "Command-Period left the focused session in place");
    await h.press(PREVIOUS);
    await h.settle(() => /s1$/.test(h.focusedSlot() ?? ""), "Command-Comma left the focused session in place");
    await h.press(PREVIOUS);
    await h.settle(() => /s5$/.test(h.focusedSlot() ?? ""), "Command-Comma did not wrap like the list pager");
    const composer = h.window.document.createElement("textarea");
    h.container.append(composer);
    await h.press(NEXT, composer);
    await h.settle(() => /s1$/.test(h.focusedSlot() ?? ""), "Command-Period did nothing from the reply composer");
    await h.press(PREVIOUS);
    await h.settle(() => /s5$/.test(h.focusedSlot() ?? ""), "Command-Comma did not wrap again");

    await h.press({ key: "`", code: "Backquote" });
    await h.settle(() => h.pageLabel() === "2 / 2", "the list did not return on the page the shortcut reached");
  } finally { await h.close(); }
});

const COMMAND_T = { key: "t", code: "KeyT" };
const dialog = (h: Awaited<ReturnType<typeof mountDashboard>>) => h.window.document.querySelector<HTMLElement>('[aria-label="New session"][role="dialog"]');

test("Command-T closes the New session dialog from its inputs and reopens it empty", async () => {
  const h = await mountDashboard();
  try {
    await h.press(COMMAND_T);
    await h.settle(() => dialog(h) !== null, "Command-T did not open the dialog");
    const input = dialog(h)!.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(h.window.HTMLInputElement.prototype, "value")!.set!.call(input, "half entered");
      input.dispatchEvent(new h.window.Event("input", { bubbles: true }) as unknown as Event);
    });

    await h.press(COMMAND_T, input);
    await h.settle(() => dialog(h) === null, "Command-T did not close the dialog from its input");

    await h.press(COMMAND_T);
    await h.settle(() => dialog(h) !== null, "Command-T did not reopen the dialog");
    assert.equal(dialog(h)!.querySelector("input")!.value, "");
  } finally { await h.close(); }
});

test("Command-T leaves the New session dialog open outside the macOS app", async () => {
  const h = await mountDashboard(false);
  try {
    await act(async () => h.container.querySelector<HTMLButtonElement>('button[aria-label="New session"]')!.click());
    await h.settle(() => dialog(h) !== null, "the header button did not open the dialog");
    await h.press(COMMAND_T, dialog(h)!.querySelector("input")!);
    assert.ok(dialog(h));
  } finally { await h.close(); }
});

const has = (h: Awaited<ReturnType<typeof mountDashboard>>, selector: string) => h.window.document.querySelector<HTMLElement>(selector);

test("Command-5 closes the Repair sessions confirmation from its buttons", async () => {
  const h = await mountDashboard();
  try {
    await h.press({ key: "5", code: "Digit5" });
    await h.settle(() => has(h, '[role="dialog"]') !== null, "Command-5 did not open the confirmation");
    await h.press({ key: "5", code: "Digit5" }, has(h, '[role="dialog"] button')!);
    await h.settle(() => has(h, '[role="dialog"]') === null, "Command-5 did not close the confirmation");
  } finally { await h.close(); }
});

test("Command-E closes the inline rename editor from its input", async () => {
  const h = await mountDashboard();
  try {
    await h.press({ key: "2", code: "Digit2" });
    await h.settle(() => h.focusedSlot() !== null, "Command-2 did not focus a session");
    await h.press({ key: "e", code: "KeyE" });
    await h.settle(() => has(h, ".slot-title-input") !== null, "Command-E did not open the editor");
    await h.press({ key: "e", code: "KeyE" }, has(h, ".slot-title-input")!);
    await h.settle(() => has(h, ".slot-title-input") === null, "Command-E did not close the editor");
  } finally { await h.close(); }
});

test("Command-I closes the Voice prompt from inside it", async () => {
  const h = await mountDashboard();
  try {
    await h.press({ key: "2", code: "Digit2" });
    await h.settle(() => h.focusedSlot() !== null, "Command-2 did not focus a session");
    await h.press({ key: "i", code: "KeyI" });
    await h.settle(() => has(h, '[aria-label="Voice prompt"]') !== null, "Command-I did not open the prompt");
    await h.press({ key: "i", code: "KeyI" }, has(h, '[aria-label="Voice prompt"] button')!);
    await h.settle(() => has(h, '[aria-label="Voice prompt"]') === null, "Command-I did not close the prompt");
  } finally { await h.close(); }
});
