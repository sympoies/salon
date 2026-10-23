import { sharedAdmissionFixture } from "./support/sharedAdmissionFixture.ts";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Plugin } from "vite";
import type { Session } from "../src/types.ts";
import { assertActiveElement } from "./support/domAssert.ts";
import { makeSession } from "./support/fixtures.ts";
import { createUiSsrHarness } from "./support/ssr.ts";

declare global {
  var __agentConsoleStatusSubmit: (() => Promise<{ ok: boolean; queued?: boolean; error?: string }>) | undefined;
  var __agentConsoleStatusUpload: ((machine: string, id: string, file: File) => Promise<{ ok: boolean; path?: string; error?: string }>) | undefined;
  var __agentConsoleStatusMac: boolean | undefined;
  var __agentConsoleStatusNativeFiles: (() => Promise<File[]>) | undefined;
}
const boundaries: Plugin = {
  name: "composer-status-boundaries", enforce: "pre",
  resolveId(id, importer) {
    if (id.endsWith("sharedOutboxClient.ts")) return "\0shared-admission-fixture";
    if (!importer?.includes("/src/")) return;
    if (id === "./api.ts") return "\0status-api";
    if (id === "./SpeechComposer.tsx") return "\0status-speech";
    if (id === "./runtime.ts") return "\0status-runtime";
    if (id === "./terminalNativeClipboard.ts") return "\0status-native-clipboard";
  },
  load(id) {
    if (id === "\0shared-admission-fixture") return sharedAdmissionFixture("globalThis.__agentConsoleStatusSubmit");
    if (id === "\0status-api") return 'export * from "/src/api.ts?status-original"; export const submitSessionPrompt = () => globalThis.__agentConsoleStatusSubmit(); export const uploadAttachment = (...args) => globalThis.__agentConsoleStatusUpload(...args);';
    if (id === "\0status-speech") return 'export function SpeechComposer() { return null; }';
    if (id === "\0status-runtime") return 'export * from "/src/runtime.ts?status-original"; export const isMacTauri = () => globalThis.__agentConsoleStatusMac === true;';
    if (id === "\0status-native-clipboard") return 'export * from "/src/terminalNativeClipboard.ts?status-original"; export const readMacosClipboardFiles = () => globalThis.__agentConsoleStatusNativeFiles();';
  },
};
async function mount() {
  const window = new Window({ url: "http://localhost" });
  const globals = { window, document: window.document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  let now = 0, nextId = 0, calls = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  window.setTimeout = ((callback: () => void, delay = 0) => {
    const id = ++nextId; timers.set(id, { at: now + delay, run: callback }); return id;
  }) as typeof window.setTimeout;
  window.clearTimeout = ((id: number) => { timers.delete(id); }) as typeof window.clearTimeout;
  const container = window.document.createElement("div"); window.document.body.append(container);
  const root = createRoot(container), ssr = createUiSsrHarness([boundaries]);
  const { ConversationComposer } = await ssr.loadModule<typeof import("../src/ConversationComposer.tsx")>("/src/ConversationComposer.tsx");
  // This component fixture controls local journal persistence only.
  // Real admission and native-receipt behavior are tested separately.
  let session: Session = makeSession({ machine: "fixture", id: "status", agent: "claude", provider_resume: { provider: "claude", session_id: "fixture-thread" }, session_incarnation: "inc-1" });
  let response = { ok: true } as { ok: boolean; queued?: boolean; error?: string };
  globalThis.__agentConsoleStatusSubmit = async () => { calls++; return response; };
  const textarea = () => container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reply to session"]')!;
  const sendButton = () => container.querySelector<HTMLButtonElement>('[aria-label="Send reply"]')!;
  const lines = () => [...container.querySelectorAll('.conversation-composer [role="status"], .conversation-composer [role="alert"]')].map(node => node.textContent);
  const render = async (phase: string, overrides: Partial<Session> = {}) => {
    session = { ...session, ...overrides, turn_state: { schema_version: "agent-session.turn-state.v1", phase, revision: 1,
      phase_changed_at: "2030-01-01T00:00:00Z", ...(phase === "working" || phase === "starting" ? { current_turn: { started_at: "2030-01-01T00:00:00Z" } } : {}), source: { kind: "provider_hook", provider: "codex", confidence: "authoritative" } } as Session["turn_state"] };
    await act(async () => root.render(createElement(ConversationComposer, { session, machineReachable: true, onBusyChange() {}, onVoiceOpenChange() {} })));
  };
  return { window, container, textarea, sendButton, lines, render, timers, calls: () => calls,
    response(value: typeof response) { response = value; },
    async write(text: string) {
      const node = textarea();
      const prop = Object.keys(node).find(key => key.startsWith("__reactProps$"))!;
      await act(async () => (node as unknown as Record<string, { onChange(event: { target: { value: string } }): void }>)[prop]!.onChange({ target: { value: text } }));
    },
    async send() { await act(async () => { sendButton().click(); await Promise.resolve(); }); },
    // A real DOM event, so React's onPaste/onDrop see the payload as a browser delivers it.
    async dispatch(type: "paste" | "drop" | "dragover", payload: object) {
      const event = new window.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, type === "paste" ? "clipboardData" : "dataTransfer", { value: payload });
      await act(async () => { textarea().dispatchEvent(event); await new Promise(resolve => setImmediate(resolve)); });
      return event;
    },
    async advance(ms: number) {
      const target = now + ms;
      await act(async () => {
        for (;;) {
          const due = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
          if (!due) break;
          now = due[1].at; timers.delete(due[0]); due[1].run();
        }
        now = target;
      });
    },
    async unmount() { await act(async () => root.unmount()); },
    async close() {
      await act(async () => root.unmount()); await ssr.close(); delete globalThis.__agentConsoleStatusSubmit;
      for (const [key, value] of previous) value ? Object.defineProperty(globalThis, key, value) : Reflect.deleteProperty(globalThis, key);
      await window.happyDOM.close();
    },
  };
}

test("busy composer keeps the plain placeholder and never submits merely because its phase changes", async () => {
  const h = await mount();
  try {
    await h.render("idle"); assert.equal(h.textarea().placeholder, "Reply to this session…");
    await h.write("next task"); assert.equal(h.sendButton().disabled, false);
    for (const phase of ["working", "starting"]) {
      await h.render(phase);
      assert.equal(h.textarea().placeholder, "Reply to this session…", "Working shows in the message list, not the composer");
      assert.deepEqual(h.lines(), []);
      assert.equal(h.textarea().disabled, false); assert.equal(h.sendButton().disabled, false);
      assert.equal(h.calls(), 0);
    }
    await h.render("idle"); assert.equal(h.textarea().placeholder, "Reply to this session…");
    assert.equal(h.sendButton().disabled, false);
  } finally { await h.close(); }
});

// #969 (owner): a reply is its own bubble in the conversation, so the composer
// shows no Sent line, and no timer is left running.
for (const queued of [false, true]) test(`an acknowledged ${queued ? "queued" : "sent"} reply leaves no Sent line under the composer`, async () => {
  const h = await mount();
  try {
    h.response({ ok: true, queued }); await h.render("idle"); await h.write("next task"); await h.send();
    assert.equal(h.textarea().value, "");
    await h.render("working"); assert.deepEqual(h.lines(), []);
    await h.write("later"); await h.send(); await h.unmount(); assert.equal(h.timers.size, 0, "no notice timer to clean up");
  } finally { await h.close(); }
});

test("errors remain visible as a single line", async () => {
  const h = await mount();
  try {
    h.response({ ok: false, error: "Reply rejected" }); await h.render("idle"); await h.write("retry me"); await h.send();
    await h.render("working"); assert.deepEqual(h.lines(), ["Reply rejected"]);
    await h.advance(3000); assert.deepEqual(h.lines(), ["Reply rejected"]); assert.equal(h.textarea().value, "retry me");
  } finally { await h.close(); }
});

const button = (container: HTMLElement, label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
test("#942 an empty composer shows the paperclip and the mic; text swaps the mic for send", async () => {
  const h = await mount();
  try {
    await h.render("idle");
    assert.ok(button(h.container, "Attach files"), "the paperclip is always there");
    assert.ok(button(h.container, "Voice"), "an empty composer offers the mic");
    assert.equal(button(h.container, "Send reply"), null, "and no send button");
    await h.write("next task");
    assert.ok(button(h.container, "Attach files"), "the paperclip stays while typing");
    assert.ok(button(h.container, "Send reply"));
    assert.equal(button(h.container, "Voice"), null, "send replaces the mic");
    await h.write("   ");
    assert.ok(button(h.container, "Voice"), "blank text counts as empty");
  } finally { await h.close(); }
});
test("#942 attaching files uploads them to the session host and adds their quoted paths to the draft", async () => {
  const h = await mount();
  const uploads: string[] = [];
  globalThis.__agentConsoleStatusUpload = async (_machine, _id, file) => { uploads.push(file.name); return { ok: true, path: `/uploads/${file.name}` }; };
  try {
    await h.render("working");
    await h.write("see");
    const input = h.container.querySelector<HTMLInputElement>('input[type="file"]');
    assert.ok(input, "a hidden file picker backs the paperclip");
    const files = [new h.window.File(["a"], "report one.pdf"), new h.window.File(["b"], "log.txt")];
    Object.defineProperty(input, "files", { configurable: true, value: files });
    await act(async () => { input.dispatchEvent(new h.window.Event("change", { bubbles: true })); await new Promise(resolve => setImmediate(resolve)); });
    assert.deepEqual(uploads, ["report one.pdf", "log.txt"]);
    // #963: one path per line, then an empty line with the caret for the message.
    assert.equal(h.textarea().value, "see\n'/uploads/report one.pdf'\n'/uploads/log.txt'\n");
    assertActiveElement(h.window, h.textarea(), "the caret is in the draft");
    assert.equal(h.textarea().selectionStart, h.textarea().value.length, "the caret is on the empty line");
    assert.equal(h.calls(), 0, "attaching never sends on its own");
  } finally { delete globalThis.__agentConsoleStatusUpload; await h.close(); }
});
test("#942 a failed upload keeps the draft and says why", async () => {
  const h = await mount();
  globalThis.__agentConsoleStatusUpload = async () => ({ ok: false, error: "Upload too large" });
  try {
    await h.render("idle");
    await h.write("keep me");
    const input = h.container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [new h.window.File(["a"], "big.bin")] });
    await act(async () => { input.dispatchEvent(new h.window.Event("change", { bubbles: true })); await new Promise(resolve => setImmediate(resolve)); });
    assert.equal(h.textarea().value, "keep me");
    assert.deepEqual(h.lines(), ["Upload too large"]);
  } finally { delete globalThis.__agentConsoleStatusUpload; await h.close(); }
});
test("#942 review F2: send waits for an upload in flight, so the path is not left behind", async () => {
  const h = await mount();
  let finish: (value: { ok: boolean; path?: string }) => void = () => {};
  globalThis.__agentConsoleStatusUpload = () => new Promise(resolve => { finish = resolve; });
  try {
    await h.render("idle"); await h.write("see this");
    const input = h.container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [new h.window.File(["a"], "a.txt")] });
    await act(async () => { input.dispatchEvent(new h.window.Event("change", { bubbles: true })); await Promise.resolve(); });
    assert.equal(h.sendButton().disabled, true, "send is disabled while the upload runs");
    await h.send();
    assert.equal(h.calls(), 0);
    await act(async () => { finish({ ok: true, path: "/u/a.txt" }); await new Promise(resolve => setImmediate(resolve)); });
    assert.equal(h.textarea().value, "see this\n'/u/a.txt'\n");
    assert.equal(h.sendButton().disabled, false);
  } finally { delete globalThis.__agentConsoleStatusUpload; await h.close(); }
});

// #1049: the composer shares the terminal's clipboard file extraction and upload flow.
const clipboardWith = (files: File[], text = "", types = files.length ? ["Files", "text/plain"] : ["text/plain"]) =>
  ({ files, items: [], types, getData: (type: string) => (type === "text" || type === "text/plain" ? text : "") });
const providers = [["claude", "claude"], ["codex", "codex"]] as const;
for (const [agent, provider] of providers) {
  test(`#1049 ${agent}: a pasted screenshot uploads to the session host and never sends the client-local path`, async () => {
    const h = await mount();
    const uploads: Array<[string, string, string]> = [];
    globalThis.__agentConsoleStatusUpload = async (machine, id, file) => { uploads.push([machine, id, file.name]); return { ok: true, path: `/host/uploads/${file.name}` }; };
    try {
      await h.render("idle", { agent, provider_resume: { provider, session_id: "fixture-thread" } });
      const screenshot = new h.window.File(["png"], "Screenshot 1.png", { type: "image/png" });
      const event = await h.dispatch("paste", clipboardWith([screenshot], "/Users/runner/ScreenShot/Screenshot 1.png"));
      assert.equal(event.defaultPrevented, true, "the path text is not pasted beside the upload");
      assert.deepEqual(uploads, [["fixture", "status", "Screenshot 1.png"]]);
      assert.equal(h.textarea().value, "'/host/uploads/Screenshot 1.png'\n");
      assert.ok(!h.textarea().value.includes("/Users/"), "no client-local path reaches the draft");
      assert.equal(h.calls(), 0, "pasting never sends on its own");
      h.response({ ok: true });
      await h.send();
      assert.equal(h.calls(), 1);
      assert.equal(h.textarea().value, "", "the host path is what gets sent");
    } finally { delete globalThis.__agentConsoleStatusUpload; await h.close(); }
  });
}
// #1067: Chromium lists one pasted image in both files and items, with different lastModified values.
test("#1067 one image that Chromium lists in files and in items uploads once", async () => {
  const h = await mount();
  const uploads: string[] = [];
  globalThis.__agentConsoleStatusUpload = async (_machine, _id, file) => { uploads.push(file.name); return { ok: true, path: `/host/uploads/${file.name}` }; };
  try {
    await h.render("idle");
    const inFiles = new h.window.File(["png"], "image.png", { type: "image/png", lastModified: 1_000 });
    const inItems = new h.window.File(["png"], "image.png", { type: "image/png", lastModified: 2_000 });
    const event = await h.dispatch("paste", {
      files: [inFiles], items: [{ kind: "file", getAsFile: () => inItems }], types: ["Files"], getData: () => "",
    });
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(uploads, ["image.png"]);
    assert.equal(h.textarea().value, "'/host/uploads/image.png'\n");
  } finally { delete globalThis.__agentConsoleStatusUpload; await h.close(); }
});
test("#1049 plain-text paste stays with the browser and uploads nothing", async () => {
  const h = await mount();
  let uploads = 0;
  globalThis.__agentConsoleStatusUpload = async () => { uploads++; return { ok: true, path: "/never" }; };
  try {
    await h.render("idle");
    const event = await h.dispatch("paste", clipboardWith([], "just words"));
    assert.equal(event.defaultPrevented, false);
    assert.equal(uploads, 0);
  } finally { delete globalThis.__agentConsoleStatusUpload; await h.close(); }
});
test("#1049 dropped files upload the same way and the browser does not navigate to them", async () => {
  const h = await mount();
  const uploads: string[] = [];
  globalThis.__agentConsoleStatusUpload = async (_machine, _id, file) => { uploads.push(file.name); return { ok: true, path: `/host/${file.name}` }; };
  try {
    await h.render("working");
    await h.write("see");
    const files = [new h.window.File(["a"], "a.png", { type: "image/png" }), new h.window.File(["b"], "b.txt")];
    assert.equal((await h.dispatch("dragover", { types: ["Files"], files: [] })).defaultPrevented, true, "the composer accepts a file drop");
    const drop = await h.dispatch("drop", { files, items: [], types: ["Files"] });
    assert.equal(drop.defaultPrevented, true);
    assert.deepEqual(uploads, ["a.png", "b.txt"]);
    assert.equal(h.textarea().value, "see\n'/host/a.png'\n'/host/b.txt'\n");
    assert.equal((await h.dispatch("drop", { files: [], items: [], types: ["text/plain"] })).defaultPrevented, false, "text drops stay with the browser");
  } finally { delete globalThis.__agentConsoleStatusUpload; await h.close(); }
});
test("#1049 the macOS shell reads clipboard files natively when the paste carries only a file path", async () => {
  const h = await mount();
  const uploads: string[] = [];
  globalThis.__agentConsoleStatusMac = true;
  globalThis.__agentConsoleStatusNativeFiles = async () => [new h.window.File(["png"], "Screenshot 2.png", { type: "image/png" }) as unknown as File];
  globalThis.__agentConsoleStatusUpload = async (_machine, _id, file) => { uploads.push(file.name); return { ok: true, path: `/host/${file.name}` }; };
  try {
    await h.render("idle");
    const event = await h.dispatch("paste", clipboardWith([], "file:///Users/runner/ScreenShot/Screenshot%202.png", ["public.file-url", "text/plain"]));
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(uploads, ["Screenshot 2.png"]);
    assert.equal(h.textarea().value, "'/host/Screenshot 2.png'\n");
    assert.ok(!h.textarea().value.includes("/Users/"));
    // Plain text is still left to the browser in the macOS shell.
    assert.equal((await h.dispatch("paste", clipboardWith([], "just words"))).defaultPrevented, false);
  } finally {
    delete globalThis.__agentConsoleStatusUpload; delete globalThis.__agentConsoleStatusMac; delete globalThis.__agentConsoleStatusNativeFiles; await h.close();
  }
});
test("#1049 a composer that cannot take replies swallows a pasted file instead of leaking its path", async () => {
  const h = await mount();
  let uploads = 0;
  globalThis.__agentConsoleStatusUpload = async () => { uploads++; return { ok: true, path: "/never" }; };
  try {
    await h.render("idle", { status: "stopped" });
    const event = await h.dispatch("paste", clipboardWith([new h.window.File(["a"], "a.png", { type: "image/png" })], "/Users/runner/a.png"));
    assert.equal(event.defaultPrevented, true);
    assert.equal(uploads, 0);
    assert.equal(h.textarea().value, "");
  } finally { delete globalThis.__agentConsoleStatusUpload; await h.close(); }
});
