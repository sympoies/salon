import { sharedAdmissionFixture } from "./support/sharedAdmissionFixture.ts";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import type { Plugin } from "vite";
import { makeSession, makeSessionSlotProps } from "./support/fixtures.ts";
import { createUiSsrHarness } from "./support/ssr.ts";
import type { ConversationReplyDrafts } from "../src/ConversationComposer.tsx";
import { assertNoElement } from "./support/domAssert.ts";

interface Fixture {
  mounts: number;
  unmounts: number;
  reads: number;
  searches: number;
  missing: boolean;
  changes: Set<() => void>;
  submit?: (...args: unknown[]) => Promise<{ ok: boolean; error?: string; outcomeUnknown?: boolean; queued?: boolean }>;
}
declare global { var __agentConsoleTileFixture: Fixture | undefined; }

const boundaries: Plugin = {
  name: "tile-history-boundaries", enforce: "pre",
  resolveId(id, importer) {
    if (id.endsWith("sharedOutboxClient.ts")) return "\0shared-admission-fixture";
    if (id.endsWith("resourceEvents.ts")) return "\0tile-resources";
    if (!importer?.includes("/src/")) return;
    if (id.endsWith("api.ts")) return "\0tile-history-api";
    if (id.endsWith("TerminalPane.tsx")) return "\0tile-terminal";
  },
  load(id) {
    if (id === "\0shared-admission-fixture") return sharedAdmissionFixture("globalThis.__agentConsoleTileFixture.submit");
    if (id === "\0tile-resources") return `
      export const RESOURCE_RECONCILE_MS = 30000;
      export const resourceEvents = { subscribe(_key,change,health) {
        const f=globalThis.__agentConsoleTileFixture;f.changes.add(change);health(false);
        return () => {f.changes.delete(change);};
      }};
    `;
    if (id === "\0tile-terminal") return `
      import {createElement,useEffect} from "react";
      export function TerminalPane() {
        useEffect(()=>{const f=globalThis.__agentConsoleTileFixture;f.mounts++;return()=>{f.unmounts++;};},[]);
        return createElement("div",{className:"terminal-pane-mock"});
      }
    `;
    if (id === "\0tile-history-api") return `
      export * from "/src/api.ts?tile-original";
      export const submitSessionPrompt = (...args) => globalThis.__agentConsoleTileFixture.submit(...args);
      export const listHistorySessions = async machine => {
        const f=globalThis.__agentConsoleTileFixture;f.searches++;
        return {ok:true,truncated:false,latestMessagePaging:true,sessions:f.missing?[]:[{
          id:"history",machine,provider:"claude",provider_session_id:"thread",title:"Tile work",
          cwd:"/workspace",created_at:"2026-10-11T00:00:00Z",updated_at:"2026-10-11T00:00:00Z",resumable:true}]};
      };
      export const listHistoryMessages = async () => {
        const f=globalThis.__agentConsoleTileFixture;f.reads++;
        return {ok:true,messages:Array.from({length:12},(_,index)=>({id:"message-"+index,
          role:index%2?"assistant":"user",text:"message "+index+" complete response",
          timestamp:"2026-10-11T00:00:00Z"}))};
      };
    `;
  },
};

async function harness() {
  const window = new Window({ url: "http://localhost" });
  const previous = { window: globalThis.window, document: globalThis.document, Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement, Event: globalThis.Event, MouseEvent: globalThis.MouseEvent,
    KeyboardEvent: globalThis.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window, document: window.document, Element: window.Element,
    HTMLElement: window.HTMLElement, Event: window.Event, MouseEvent: window.MouseEvent,
    KeyboardEvent: window.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: true });
  const fixture: Fixture = { mounts: 0, unmounts: 0, reads: 0, searches: 0, missing: false, changes: new Set() };
  globalThis.__agentConsoleTileFixture = fixture;
  const container = window.document.createElement("div"); window.document.body.append(container);
  const root = createRoot(container);
  const ssr = createUiSsrHarness([boundaries]);
  const { SessionSlot } = await ssr.loadModule<typeof import("../src/SessionSlot.tsx")>("/src/SessionSlot.tsx");
  const { LiveConversationPanel } = await ssr.loadModule<typeof import("../src/LiveConversationPanel.tsx")>("/src/LiveConversationPanel.tsx");
  const replyDrafts: ConversationReplyDrafts = new Map();
  // Retain direct-send ACK/draft transitions; shared Codex admission has its own
  // journal tests and real three-consumer browser fixture.
  const session = makeSession({ id: "tile", machine: "fixture", agent: "claude", title: "Tile work",
    turn_state: { schema_version: "agent-session.turn-state.v1", phase: "idle", phase_changed_at: "2026-10-11T00:00:00Z", revision: 1, source: { kind: "provider_hook", provider: "claude", confidence: "authoritative" } },
    provider_resume: { provider: "claude", session_id: "thread" } });
  const props = makeSessionSlotProps({ slot: "fixture/tile", session, options: [session] });
  return { window, fixture, container, session, props,
    async render(display: "terminal" | "conversation", extra: Record<string, unknown> = {}, actions = props.actions, panel = false) {
      await act(async () => root.render(createElement(Fragment, null,
        createElement(SessionSlot, {
          ...props, actions, view: { ...props.view, conversationReplyDrafts: replyDrafts, sessionListDisplay: display, ...extra },
        }),
        panel ? createElement(LiveConversationPanel, { session, machineReachable: true, replyDrafts, docked: true, onClose() {} }) : null,
      )));
    },
    async renderPanel(panelSession: typeof session) {
      await act(async () => root.render(createElement(LiveConversationPanel, { session: panelSession, machineReachable: true, replyDrafts, docked: true, onClose() {} })));
    },
    async waitFor(condition: () => boolean) {
      for (let attempt = 0; attempt < 200; attempt++) {
        if (condition()) return;
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
      }
      assert.fail("tile fixture did not settle");
    },
    async close() {
      await act(async () => root.unmount()); await ssr.close();
      delete globalThis.__agentConsoleTileFixture; Object.assign(globalThis, previous);
      await window.happyDOM.close();
    },
  };
}

test("Conversation tiles render full history with timestamps and stop terminal mounts across switches", async () => {
  const h = await harness();
  try {
    await h.render("terminal");
    assert.equal(h.fixture.mounts, 1);
    await h.render("conversation");
    await h.waitFor(() => h.container.querySelectorAll(".history-message").length === 12);
    assert.equal(h.fixture.unmounts, 1);
    assert.equal(h.fixture.mounts, 1, "Conversation does not create another terminal");
    assertNoElement(h.container, ".terminal-pane-mock");
    assert.equal(h.container.querySelectorAll(".conversation-composer").length, 1);
    assert.match(h.container.textContent ?? "", /message 11 complete response/);
    assert.equal(h.container.querySelectorAll(".history-message time").length, 12);
    assert.equal(h.fixture.reads, 1);
    assert.equal(h.fixture.changes.size, 1);
    await act(async () => { for (const changed of h.fixture.changes) changed(); });
    await h.waitFor(() => h.fixture.reads === 2);
    await h.render("terminal");
    assert.equal(h.fixture.mounts, 2, "switching back mounts the terminal again");
    assert.equal(h.fixture.changes.size, 0, "history event listeners leave with the pane");
    assertNoElement(h.container, ".slot-conversation-pane");
  } finally { await h.close(); }
});

test("tile Open enters its focused terminal in either display mode while reading text stays in the tile", async () => {
  const h = await harness();
  const opened: string[] = []; const focused: unknown[] = [];
  try {
    const actions = { ...h.props.actions,
      onConversation: session => opened.push(session.id), setFocusedKey: value => focused.push(value) };
    await h.render("conversation", {}, actions);
    await h.waitFor(() => h.container.querySelectorAll(".history-message").length === 12);
    const message = h.container.querySelector<HTMLElement>(".history-message"); assert.ok(message);
    await act(async () => message.click());
    assert.deepEqual(opened, []);
    const open = h.container.querySelector<HTMLButtonElement>('[aria-label="Open Tile work"]'); assert.ok(open);
    await act(async () => open.click());
    assert.deepEqual(opened, [], "tile Open does not open the conversation panel");
    assert.deepEqual(focused, ["fixture/tile"], "Conversation tile Open focuses its terminal");
    await h.render("terminal", {}, actions);
    const terminalOpen = h.container.querySelector<HTMLButtonElement>('[aria-label="Open Tile work"]'); assert.ok(terminalOpen);
    await act(async () => terminalOpen.click());
    assert.deepEqual(focused, ["fixture/tile", "fixture/tile"], "Terminal mode keeps its focused-terminal behavior");
    assert.deepEqual(opened, []);
  } finally { await h.close(); }
});

test("missing or unsupported tile history is explicit and never falls back to terminal streaming", async () => {
  const h = await harness();
  try {
    h.fixture.missing = true;
    await h.render("conversation");
    await h.waitFor(() => h.container.querySelector('[role="alert"]') !== null);
    assert.match(h.container.textContent ?? "", /history|conversation/i);
    assert.equal(h.fixture.mounts, 0);
    assert.equal(h.fixture.reads, 0);
    assertNoElement(h.container, ".terminal-pane-mock");
  } finally { await h.close(); }
});

async function writeReply(h: Awaited<ReturnType<typeof harness>>, text: string, scope: ParentNode = h.container) {
  const node = scope.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reply to session"]');
  assert.ok(node, "each Conversation tile has the shared reply editor");
  await act(async () => {
    const key = Object.keys(node).find(key => key.startsWith('__reactProps$'))!;
    (node as unknown as Record<string, { onChange(event: { target: { value: string } }): void }>)[key].onChange({ target: { value: text } });
  });
  return node;
}

async function sendReply(h: Awaited<ReturnType<typeof harness>>) {
  const send = h.container.querySelector<HTMLButtonElement>('[aria-label="Send reply"]');
  assert.ok(send);
  await act(async () => send.click());
}

test("a tile fences its reply target, sends once, and clears only after ACK without opening a pane", async () => {
  const h = await harness();
  const requests: unknown[][] = [];
  let acknowledge!: (result: { ok: boolean; queued: boolean }) => void;
  const pending = new Promise<{ ok: boolean; queued: boolean }>(resolve => { acknowledge = resolve; });
  h.fixture.submit = (...args) => { requests.push(args); return pending; };
  const opened: string[] = [];
  try {
    await h.render("conversation", {}, { ...h.props.actions, onConversation: session => opened.push(session.id) });
    const editor = await writeReply(h, "first line\nsecond line");
    await sendReply(h);
    await sendReply(h);
    assert.deepEqual(requests, [["fixture", "tile", { text: "first line\nsecond line", expected_session_incarnation: h.session.session_incarnation }]]);
    assert.equal(editor.value, "first line\nsecond line");
    assert.equal(editor.disabled, true);
    await act(async () => acknowledge({ ok: true, queued: true }));
    assert.equal(editor.value, "");
    assert.doesNotMatch(h.container.textContent ?? "", /\bSent\b/, "no Sent notice: the reply is its own bubble (#969)");
    assert.deepEqual(opened, []);
    await h.render("terminal");
    assertNoElement(h.container, ".conversation-composer");
  } finally { await h.close(); }
});

test("a tile preserves a failed local admission and clears only after persistence succeeds", async () => {
  const h = await harness(); let requests = 0;
  h.fixture.submit = async () => ++requests === 1
    ? { ok: false, error: "Local storage unavailable" } : { ok: true };
  try {
    await h.render("conversation"); const editor = await writeReply(h, "keep this reply");
    await sendReply(h); assert.equal(editor.value, "keep this reply");
    assert.match(h.container.textContent ?? "", /Local storage unavailable/);
    await sendReply(h); assert.equal(editor.value, ""); assert.equal(requests, 2);
  } finally { await h.close(); }
});

test("pending local admissions stay exclusive across simultaneous and replacement full-pane composers", async () => {
  const h = await harness();
  let requests = 0;
  let settle!: (result: { ok: boolean; outcomeUnknown?: boolean }) => void;
  const pending = new Promise<{ ok: boolean; outcomeUnknown?: boolean }>(resolve => { settle = resolve; });
  h.fixture.submit = () => { requests++; return pending; };
  try {
    await h.render("conversation");
    await writeReply(h, "pending command");
    await sendReply(h);
    await h.render("conversation", {}, h.props.actions, true);
    const editors = [...h.container.querySelectorAll<HTMLTextAreaElement>('textarea')];
    assert.equal(editors.length, 2);
    assert.deepEqual(editors.map(node => [node.value, node.disabled]), [["pending command", true], ["pending command", true]]);
    const buttons = [...h.container.querySelectorAll<HTMLButtonElement>('[aria-label="Send reply"]')];
    await act(async () => buttons.forEach(button => button.click()));
    assert.equal(requests, 1);
    await h.render("terminal", {}, h.props.actions, true);
    assert.equal(h.container.querySelector<HTMLTextAreaElement>('textarea')?.disabled, true);
    await act(async () => settle({ ok: true }));
    assert.equal(h.container.querySelector<HTMLTextAreaElement>('textarea')?.disabled, false);
    assert.equal(h.container.querySelector<HTMLTextAreaElement>('textarea')?.value, "");
    assert.equal(requests, 1);
    await h.render("conversation");
    assert.equal(h.container.querySelector<HTMLTextAreaElement>('textarea')?.value, "");
    assertNoElement(h.container, '[aria-label="Send reply"]');
  } finally { await h.close(); }
});

for (const accepted of [true, false]) {
  test(`a full-pane reply ${accepted ? "ACK clears" : "rejection preserves"} its draft after unmounting into a tile`, async () => {
    const h = await harness();
    let requests = 0;
    let settle!: (result: { ok: boolean; error?: string }) => void;
    const pending = new Promise<{ ok: boolean; error?: string }>(resolve => { settle = resolve; });
    h.fixture.submit = () => { requests++; return pending; };
    try {
      await h.render("terminal", {}, h.props.actions, true);
      await writeReply(h, "full-pane command");
      await sendReply(h);
      await h.render("terminal");
      await act(async () => settle(accepted ? { ok: true } : { ok: false, error: "Reply rejected after switch" }));
      await h.render("conversation");
      const editor = h.container.querySelector<HTMLTextAreaElement>('textarea');
      assert.ok(editor);
      assert.equal(editor.value, accepted ? "" : "full-pane command");
      assert.equal(editor.disabled, false);
      if (!accepted) assert.match(h.container.textContent ?? "", /Reply rejected after switch/);
      assert.equal(requests, 1);
    } finally { await h.close(); }
  });
}

// Match writeReply's boundary: React DOM was imported before this per-test Window.
// Browser fixtures below exercise real bubbling and textarea default actions.
function dispatchReplyKey(editor: HTMLTextAreaElement, event: KeyboardEvent) {
  const key = Object.keys(editor).find(key => key.startsWith("__reactProps$"))!;
  const props = (editor as unknown as Record<string, { onKeyDown?: (event: {
    key: string; shiftKey: boolean; nativeEvent: KeyboardEvent; preventDefault(): void;
  }) => void }>)[key];
  props.onKeyDown?.({ key: event.key, shiftKey: event.shiftKey, nativeEvent: event, preventDefault: () => event.preventDefault() });
}

for (const panel of [false, true]) {
  const view = panel ? "full pane" : "tile";
  test(`${view} Enter sends once and clears only after the queued ACK`, async () => {
    const h = await harness();
    h.window.innerWidth = 1500;
    // happy-dom combines comma-separated queries with AND; use its width query
    // for these fine-pointer cases. Real coarse/fine layout queries run in Chrome.
    const matchMedia = h.window.matchMedia.bind(h.window);
    h.window.matchMedia = query => matchMedia(query.includes(",") ? "(max-width: 760px)" : query);
    const requests: unknown[][] = [];
    let settle!: (result: { ok: boolean; queued: boolean }) => void;
    const pending = new Promise<{ ok: boolean; queued: boolean }>(resolve => { settle = resolve; });
    h.fixture.submit = (...args) => { requests.push(args); return pending; };
    try {
      await h.render(panel ? "terminal" : "conversation", {}, h.props.actions, panel);
      const editor = await writeReply(h, "  first line\nsecond line  ");
      const enter = new h.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
      await act(async () => { dispatchReplyKey(editor, enter); dispatchReplyKey(editor, new h.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
      assert.deepEqual(requests, [["fixture", "tile", { text: "first line\nsecond line", expected_session_incarnation: h.session.session_incarnation }]]);
      assert.equal(enter.defaultPrevented, true);
      assert.equal(editor.value, "  first line\nsecond line  ");
      assert.equal(editor.disabled, true);
      await act(async () => settle({ ok: true, queued: true }));
      assert.equal(editor.value, "");
      assert.doesNotMatch(h.container.textContent ?? "", /\bSent\b/, "no Sent notice: the reply is its own bubble (#969)");
      await act(async () => dispatchReplyKey(editor, new h.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
      assert.equal(requests.length, 1, "empty Enter does not submit");
    } finally { await h.close(); }
  });

  test(`${view} leaves Shift+Enter, composition Enter and phone Enter to the textarea`, async () => {
    const h = await harness();
    h.window.innerWidth = 1500;
    // happy-dom combines comma-separated queries with AND; use its width query
    // for these fine-pointer cases. Real coarse/fine layout queries run in Chrome.
    const matchMedia = h.window.matchMedia.bind(h.window);
    h.window.matchMedia = query => matchMedia(query.includes(",") ? "(max-width: 760px)" : query);
    let requests = 0;
    h.fixture.submit = async () => { requests++; return { ok: true }; };
    try {
      await h.render(panel ? "terminal" : "conversation", {}, h.props.actions, panel);
      const editor = await writeReply(h, "keep drafting");
      for (const properties of [{ shiftKey: true }, { isComposing: true }, { keyCode: 229 }]) {
        const event = new h.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
        for (const [key, value] of Object.entries(properties)) Object.defineProperty(event, key, { value });
        await act(async () => dispatchReplyKey(editor, event));
        assert.equal(event.defaultPrevented, false);
        assert.equal(requests, 0);
        assert.equal(editor.value, "keep drafting");
      }
      for (const width of [384, 760]) {
        h.window.innerWidth = width;
        const event = new h.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
        await act(async () => dispatchReplyKey(editor, event));
        assert.equal(event.defaultPrevented, false);
        assert.equal(requests, 0);
      }
    } finally { await h.close(); }
  });
}

// #942: the agent's working state shows as one line at the bottom of the
// message list, like a chat app's typing indicator, not in the composer.
test("#942 a working session ends the message list with an animated Working line, and an idle one does not", async () => {
  const h = await harness();
  const phase = (value: string) => ({ ...h.session, turn_state: { ...h.session.turn_state!, phase: value, revision: 2,
    ...(value === "working" ? { current_turn: { started_at: "2026-10-11T00:00:00Z" } } : {}) } }) as typeof h.session;
  try {
    await h.renderPanel(phase("working"));
    await h.waitFor(() => h.container.querySelectorAll(".history-message").length === 12);
    const line = h.container.querySelector(".history-messages > .history-working:last-child");
    assert.ok(line, "the Working line is the last item in the list");
    assert.equal(line.textContent, "Working");
    assert.equal(line.querySelectorAll(".history-working-dots > span").length, 3, "three animated dots");
    // #963: the dots follow the word, as in a chat app's "is typing…".
    assert.equal(line.firstChild?.textContent, "Working", "the text comes first");
    assert.equal(line.lastElementChild?.className, "history-working-dots", "the dots follow the text");
    assertNoElement(line, ".history-bubble");
    await h.renderPanel(phase("starting"));
    assert.ok(h.container.querySelector(".history-working"), "a starting turn counts as working");
    await h.renderPanel(phase("idle"));
    assertNoElement(h.container, ".history-working");
    await h.renderPanel(phase("needs_input"));
    assertNoElement(h.container, ".history-working");
  } finally { await h.close(); }
});
