import { strict as assert } from "node:assert";
import { test } from "node:test";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Plugin } from "vite";
import type { SharedOutboxItem, SharedOutboxSnapshot } from "@agent-console/shared/shared-outbox";
import type { HistoryMessage } from "../src/types.ts";
import { makeSession } from "./support/fixtures.ts";
import { createUiSsrHarness } from "./support/ssr.ts";
import { assertNoElement } from "./support/domAssert.ts";
import { openReplyMenu, replyMenuItem } from "./support/replyMenu.ts";

const session = makeSession({ machine: "fixture", id: "shared-reply", agent: "codex", session_incarnation: "inc-1",
  provider_resume: { provider: "codex", session_id: "fixture-thread" },
  turn_state: { schema_version: "agent-session.turn-state.v1", phase: "working", revision: 1,
    phase_changed_at: new Date().toISOString(), current_turn: { started_at: new Date().toISOString() },
    source: { kind: "provider_hook", provider: "codex", confidence: "authoritative" } } });

// Only HTTP is simulated here. The production composer, runtime, API and IDB
// admission journal run unchanged. Real edge/browser isolation is a separate test.
async function fixture(factory: IDBFactory | null = new IDBFactory(), renderComposer = true, activeSession = session) {
  const window = new Window({ url: "http://localhost" });
  Object.defineProperty(window.navigator, "locks", { configurable: true, value: { request: async (_n: unknown, _o: unknown, cb: (v: object) => unknown) => cb({}) } });
  const admissions: { id: string; text: string }[] = [];
  let mode: "normal" | "lost-put" | "malformed-put" | "lost-patch" = "normal";
  const patches: unknown[] = [];
  const requests: string[] = [];
  const principalHeaders: (string | null)[] = [];
  let remotePrincipal: string | undefined;
  let nextRead: (() => Promise<Response>) | undefined;
  let transcript: readonly HistoryMessage[] = [];
  let snapshot: SharedOutboxSnapshot = { revision: 0, items: [], compose_holds: [] };
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost"), method = init?.method ?? "GET";
    requests.push(method);
    const principal = new Headers(init?.headers).get("x-console-expected-principal");
    principalHeaders.push(principal);
    if (remotePrincipal !== undefined && principal !== remotePrincipal) {
      return Response.json({ ok: false, error: { code: "outbox-principal-changed" } }, { status: 409 });
    }
    if (method === "GET" && nextRead) {
      const read = nextRead; nextRead = undefined; return read();
    }
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (!url.pathname.includes("/outbox")) throw new Error("Unexpected transport");
    if (method === "PUT") {
      const id = url.pathname.split("/").at(-1)!;
      admissions.push({ id, text: body.text });
      const item: SharedOutboxItem = snapshot.items.find(item => item.id === id) ?? {
        id, text: body.text, session_incarnation: body.expected_session_incarnation, state: "queued", revision: 1,
        created_at: Date.now(), updated_at: Date.now(), request_id: null, receipt: null, edit_hold: null, error_code: null,
      };
      snapshot = { ...snapshot, revision: snapshot.revision + 1, items: [item] };
      if (mode === "lost-put") throw new TypeError("Synthetic lost acknowledgement");
      if (mode === "malformed-put") return Response.json({ ok: true, data: { item: { ...item, session_incarnation: "wrong-incarnation" } } }, { status: 201 });
      return Response.json({ ok: true, data: { item } }, { status: 201 });
    }
    if (method === "PATCH") {
      patches.push(body);
      const intent = url.pathname.endsWith("/outbox") ? null : url.pathname.split("/").at(-1)!;
      if (intent) {
        const item = snapshot.items.find(item => item.id === intent)!;
        if (body.base_revision !== item.revision) return Response.json({ ok: false, error: { code: "outbox-revision-conflict" } }, { status: 409 });
        const changed: SharedOutboxItem = { ...item, revision: item.revision + 1,
          ...(body.operation === "discard_refused" || body.operation === "cancel" ? { state: "cancelled" as const } : {}),
          ...(body.operation === "retry_refused" ? { state: "queued" as const, receipt: null, request_id: null } : {}),
          ...(body.operation === "begin_edit" ? { edit_hold: body.hold_id } : {}),
          ...(body.operation === "release_edit" || body.operation === "save_edit" ? { edit_hold: null } : {}),
          ...(body.operation === "save_edit" ? { text: body.text } : {}) };
        snapshot = { ...snapshot, revision: snapshot.revision + 1, items: snapshot.items.map(item => item.id === intent ? changed : item) };
        if (body.operation === "retry_refused" || body.operation === "discard_refused") {
          if (mode === "lost-patch") throw new TypeError("Synthetic lost mutation acknowledgement");
          return Response.json({ ok: true, data: { item: changed } });
        }
      } else {
        if (body.base_revision !== snapshot.revision) return Response.json({ ok: false, error: { code: "outbox-revision-conflict" } }, { status: 409 });
        snapshot = { ...snapshot, revision: snapshot.revision + 1,
          compose_holds: body.operation === "begin_compose" ? [...new Set([...snapshot.compose_holds, body.hold_id])] : snapshot.compose_holds.filter(id => id !== body.hold_id) };
      }
      if (mode === "lost-patch") throw new TypeError("Synthetic lost mutation acknowledgement");
    }
    return Response.json({ ok: true, data: snapshot });
  };
  const globals = { window, navigator: window.navigator, document: window.document, HTMLElement: window.HTMLElement,
    indexedDB: factory ?? undefined, fetch, IS_REACT_ACT_ENVIRONMENT: true };
  const saved = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const speech: Plugin = { name: "shared-outbox-speech", enforce: "pre", resolveId(id) { if (id === "./SpeechComposer.tsx") return "\0speech"; },
    load(id) { if (id === "\0speech") return "export function SpeechComposer(){return null;}"; } };
  const ssr = createUiSsrHarness([speech]), container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  const storage = await ssr.loadModule<typeof import("../src/storage.ts")>("/src/storage.ts");
  storage.setPrincipalStorageNamespace("alice");
  const { ConversationComposer } = await ssr.loadModule<typeof import("../src/ConversationComposer.tsx")>("/src/ConversationComposer.tsx");
  const settle = async () => { await act(async () => { for (let i = 0; i < 30; i++) await new Promise<void>(resolve => setImmediate(resolve)); }); };
  if (renderComposer) await act(async () => root.render(createElement(ConversationComposer, { session: activeSession, machineReachable: true, onBusyChange() {}, onVoiceOpenChange() {} })));
  await settle();
  const editor = () => container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reply to session"]')!;
  const module = await ssr.loadModule<typeof import("../src/sharedOutboxClient.ts")>("/src/sharedOutboxClient.ts");
  const client = module.sharedOutboxClient(), target = module.sharedOutboxTarget(session);
  return { admissions, patches, requests, principalHeaders, remotePrincipal(value: string) { remotePrincipal = value; }, ssr, container, editor, snapshot: () => snapshot, settle, client, target, module,
    blockRead() {
      let release = () => {}, started = () => {};
      const entered = new Promise<void>(resolve => { started = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      nextRead = async () => { const saved = snapshot; started(); await gate; return Response.json({ ok: true, data: saved }); };
      return { entered, release };
    },
    async showReplies(shown = session, messages: readonly HistoryMessage[] = transcript) {
      const { SharedOutgoingReplies } = await ssr.loadModule<typeof import("../src/SharedOutgoingReplies.tsx")>("/src/SharedOutgoingReplies.tsx");
      await act(async () => root.render(createElement(SharedOutgoingReplies, { session: shown, messages }))); await settle();
    },
    async showFailedComposer() {
      await act(async () => root.render(createElement(ConversationComposer, {
        session: { ...session, turn_state: { ...session.turn_state!, phase: "idle", revision: 2,
          last_turn: { completed_at: new Date().toISOString(), outcome: "failed", provider_failure_kind: "provider_capacity" } } as typeof session.turn_state },
        machineReachable: true, onBusyChange() {}, onVoiceOpenChange() {},
        messages: [{ id: "failed-task", role: "user", text: "retry this task" }],
      }))); await settle();
    },
    mode(value: typeof mode) { mode = value; },
    online(value: boolean) { Object.defineProperty(window.navigator, "onLine", { value, configurable: true }); },
    messages(value: readonly HistoryMessage[]) { transcript = value; },
    server(value: SharedOutboxSnapshot) { snapshot = value; },
    // Rendering fixtures that represent a known local send must retain that
    // ownership explicitly; a server snapshot alone is never sender evidence.
    async ownServer(value: SharedOutboxSnapshot) {
      await this.cacheJournal({ ...client.state(target), localIntentIds: value.items.map(item => item.id) });
      snapshot = value;
    },
    async cacheJournal(row: import("../src/sharedOutboxClient.ts").SharedClientTarget) {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = factory!.open("agent-console-shared-admissions", 1);
        open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("targets", "readwrite"); tx.objectStore("targets").put(row);
        tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    async send(text: string) {
      const node = editor(), key = Object.keys(node).find(key => key.startsWith("__reactProps$"))!;
      await act(async () => (node as unknown as Record<string, { onChange(e: { target: { value: string } }): void }>)[key]!.onChange({ target: { value: text } }));
      await settle();
      const button = container.querySelector<HTMLButtonElement>('button[aria-label="Send reply"]');
      assert.ok(button); assert.equal(button.disabled, false);
      await act(async () => button.click()); await settle();
    },
    async close() { await act(async () => root.unmount()); client.close(); await ssr.close(); for (const [key, value] of saved) value ? Object.defineProperty(globalThis, key, value) : Reflect.deleteProperty(globalThis, key); await window.happyDOM.close(); },
  };
}

test("sent reply bubbles have no editing controls or permanent delivery badges", async () => {
  const h = await fixture(new IDBFactory(), false);
  try {
    await h.client.enqueue(session, "immutable sent message");
    await h.client.sync(h.target); await h.client.sync(h.target);
    await h.showReplies();
    const bubble = h.container.querySelector<HTMLElement>(".history-outgoing-bubble")!;
    assert.ok(bubble);
    await act(async () => bubble.click()); await h.settle();
    assertNoElement(h.container, 'textarea, [role="menu"], [aria-haspopup="menu"]',
      "sent messages must not open a post-send editor or action menu");
    assertNoElement(h.container, ".history-outgoing-status",
      "normal conversation has no persistent delivery badge");
    assert.equal(h.patches.length, 0);
  } finally { await h.close(); }
});

test("a stored edit from an older client is preserved without replaying its mutation or hold", async () => {
  const factory = new IDBFactory(), h = await fixture(factory, false);
  let restored: InstanceType<typeof h.module.SharedOutboxClient> | undefined;
  try {
    const original = h.client.state(h.target);
    const legacy = { ...original, mutation: { id: "earlier-reply", body: {
      operation: "save_edit", text: "preserved unsent correction", hold_id: "earlier-hold",
      expected_session_incarnation: "inc-1", base_revision: 1,
    } }, holds: [{ id: "earlier-compose-hold", owner: "old-tab", wanted: true }], release_holds: [] };
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = factory.open("agent-console-shared-admissions", 1);
      open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("targets", "readwrite"); tx.objectStore("targets").put(legacy);
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    });
    db.close();
    restored = new h.module.SharedOutboxClient(h.client.namespace, factory);
    await restored.ready; await restored.sync(h.target);
    assert.deepEqual(restored.retainedEdits(session).map(draft => draft.text), ["preserved unsent correction"]);
    assert.deepEqual(h.requests.filter(method => method !== "GET"), []);
    assert.equal(typeof (restored as unknown as { mutate?: unknown }).mutate, "undefined");
    assert.equal(typeof (restored as unknown as { compose?: unknown }).compose, "undefined");
  } finally { restored?.close(); await h.close(); }
});

for (const provider of ["codex", "claude"] as const) test(`new busy ${provider} reply is admitted to the shared edge collection before the composer clears`, async () => {
  const h = await fixture(new IDBFactory(), true, { ...session, agent: provider,
    provider_resume: { provider, session_id: "fixture-thread" } });
  try {
    await h.send("shared next turn");
    assert.equal(h.admissions.length, 1, "the production composer admits the new intent at the edge");
    assert.equal(h.snapshot().items[0]?.text, "shared next turn");
    assert.equal(h.editor().value, "");
  } finally { await h.close(); }
});

test("new input remains keyed without Web Locks or a client-side turn-state eligibility check", async () => {
  const h = await fixture(new IDBFactory(), true, { ...session, turn_state: undefined });
  try {
    Object.defineProperty(navigator, "locks", { value: undefined, configurable: true });
    await h.send("Let the native provider accept this input");
    assert.equal(h.admissions.length, 1);
    assert.ok(h.admissions[0]!.id);
    assert.equal(h.editor().value, "");
  } finally { await h.close(); }
});

test("offline new intent survives local restart and uploads its original ID exactly once", async () => {
  const factory = new IDBFactory(), h = await fixture(factory, false);
  const clients: { close(): void }[] = [];
  try {
    h.online(false);
    const id = await h.client.enqueue(session, "offline original");
    assert.equal(h.client.state(h.target).admissions[0]?.attempted, false);
    assert.equal(h.admissions.length, 0);
    const restored = new h.module.SharedOutboxClient(h.client.namespace, factory); clients.push(restored); await restored.ready;
    assert.equal(restored.state(h.target).admissions[0]?.id, id);
    h.online(true); await restored.sync(h.target); await h.client.sync(h.target);
    assert.deepEqual(h.admissions, [{ id, text: "offline original" }]);
    assert.equal(restored.state(h.target).admissions.length, 0);
  } finally { for (const client of clients) client.close(); await h.close(); }
});
for (const mode of ["lost-put", "malformed-put"] as const) test(`${mode}: ambiguous admission reconciles the same intent without a second submission`, async () => {
  const h = await fixture(new IDBFactory(), false);
  try {
    h.mode(mode); await h.client.enqueue(session, "uncertain admission"); await h.client.sync(h.target); await h.settle();
    // The server accepted the intention even though its ACK was unusable.
    h.mode("normal"); await h.client.sync(h.target);
    assert.equal(h.admissions.length, 1);
    assert.equal(h.client.state(h.target).snapshot.items[0]?.id, h.admissions[0]?.id);
    assert.equal(h.client.state(h.target).admissions.length, 0);
  } finally { await h.close(); }
});

test("actual incarnation replacement preserves local text without uploading it", async () => {
  const h = await fixture(new IDBFactory(), false);
  try {
    h.online(false); await h.client.enqueue(session, "old target only");
    h.client.observe([{ ...session, session_incarnation: "replacement" }]);
    h.online(true); await h.client.sync(h.target);
    assert.equal(h.admissions.length, 0);
    assert.equal(h.client.state(h.target).admissions[0]?.text, "old target only");
    assert.match(h.client.error(h.target) ?? "", /restarted/);
  } finally { await h.close(); }
});

test("unavailable durable storage preserves the composer draft and makes no queue request", async () => {
  const h = await fixture(null);
  try {
    await h.send("keep this unsaved draft");
    assert.equal(h.editor().value, "keep this unsaved draft");
    assert.equal(h.client.state(h.target).admissions.length, 0);
    assert.deepEqual(h.requests, [], "the write-capable client must establish storage before synchronizing");
    assert.match(h.container.textContent, /storage.*unavailable/i);
  } finally { await h.close(); }
});

test("account replacement during a collection read cannot upload or import the old principal's text", async () => {
  const factory = new IDBFactory(), h = await fixture(factory, false);
  const storage = await h.ssr.loadModule<typeof import("../src/storage.ts")>("/src/storage.ts");
  let replacement: InstanceType<typeof h.module.SharedOutboxClient> | undefined;
  const gate = h.blockRead();
  try {
    h.online(false); const id = await h.client.enqueue(session, "original account only");
    h.online(true); const sync = h.client.sync(h.target); await gate.entered;
    storage.setPrincipalStorageNamespace("replacement-account"); gate.release(); await sync;
    assert.equal(h.admissions.length, 0);
    assert.equal(h.client.state(h.target).admissions[0]?.id, id);
    replacement = new h.module.SharedOutboxClient(h.module.sharedOutboxNamespace(), factory); await replacement.ready;
    assert.equal(replacement.state(h.target).admissions.length, 0);
    await assert.rejects(h.client.enqueue(session, "stale composer"), /account changed/i);
    storage.setPrincipalStorageNamespace("alice");
    await h.client.sync(h.target);
    assert.deepEqual(h.admissions, [{ id, text: "original account only" }]);
  } finally { gate.release(); replacement?.close(); storage.setPrincipalStorageNamespace("alice"); await h.close(); }
});

test("enqueue during an in-flight refresh is retained and admitted without waiting for the poll timer", async () => {
  const h = await fixture(new IDBFactory(), false), gate = h.blockRead();
  try {
    const sync = h.client.sync(h.target); await gate.entered;
    const id = await h.client.enqueue(session, "arrived during refresh");
    gate.release(); await sync; await h.settle();
    assert.deepEqual(h.admissions, [{ id, text: "arrived during refresh" }]);
  } finally { gate.release(); await h.close(); }
});

test("an unknown server delivery remains visible with no retry or provider replay", async () => {
  const h = await fixture(new IDBFactory(), false);
  try {
    const id = crypto.randomUUID(), requestId = crypto.randomUUID();
    await h.ownServer({ revision: 4, compose_holds: [], items: [{
      id, text: "uncertain server delivery", state: "unknown", revision: 4, session_incarnation: "inc-1",
      created_at: 1, updated_at: 2, request_id: requestId, edit_hold: null, error_code: "structured-prompt-outcome-unknown",
      receipt: { request_id: requestId, session_id: session.id, session_incarnation: "inc-1", outcome: "unknown", code: "structured-prompt-outcome-unknown" },
    }] });
    await h.client.sync(h.target); await h.showReplies();
    assert.ok(h.container.textContent?.includes("uncertain server delivery"));
    assertNoElement(h.container, '[role="menuitem"], .history-outgoing-status');
    await act(async () => { await h.client.sync(h.target); await h.client.sync(h.target); });
    assert.deepEqual(h.requests.filter(method => method !== "GET"), []);
    assert.equal(h.client.state(h.target).snapshot.items[0]?.request_id, requestId);
  } finally { await h.close(); }
});

test("a command_dispatched shared reply is terminal: no bubble, no error, no pending composer and no resend", async () => {
  const h = await fixture(new IDBFactory(), false);
  try {
    const id = crypto.randomUUID(), requestId = crypto.randomUUID();
    await h.ownServer({ revision: 3, compose_holds: [], items: [{
      id, text: "/status", state: "command_dispatched", revision: 3, session_incarnation: "inc-1",
      created_at: 1, updated_at: 2, request_id: requestId, edit_hold: null, error_code: null,
      receipt: { request_id: requestId, session_id: session.id, session_incarnation: "inc-1", outcome: "command_dispatched", code: null },
    }] });
    await h.client.sync(h.target);
    assert.equal(h.client.state(h.target).snapshot.items[0]?.state, "command_dispatched", "the client accepts the new terminal state");
    assert.equal(h.client.error(h.target), undefined);
    await h.showReplies();
    assertNoElement(h.container, ".history-outgoing-reply, [role=\"alert\"]");
    await act(async () => { await h.client.sync(h.target); });
    assert.deepEqual(h.requests.filter(method => method !== "GET"), []);
    await h.showFailedComposer();
    assert.ok([...h.container.querySelectorAll("button")].some(button => button.textContent === "Resend"),
      "a finished command is not a pending reply and must not hold back the resend");
  } finally { await h.close(); }
});

// The transcript shows a submitted message; a second bubble would repeat it.
for (const provider of ["codex", "claude"] as const) test(`a submitted ${provider} reply stays visible until its transcript arrives`, async () => {
  const factory = new IDBFactory();
  let h = await fixture(factory, false);
  try {
    const id = crypto.randomUUID(), requestId = crypto.randomUUID();
    await h.ownServer({ revision: 3, compose_holds: [], items: [{
      id, text: "already in the transcript", state: "submitted", revision: 3, session_incarnation: "inc-1",
      created_at: 1, updated_at: 2, request_id: requestId, edit_hold: null, error_code: null,
      receipt: { request_id: requestId, session_id: session.id, session_incarnation: "inc-1", outcome: "submitted", code: null },
    }] });
    await h.client.sync(h.target);
    await h.showReplies({ ...session, agent: provider, provider_resume: { provider, session_id: "fixture-thread" } });
    assert.equal(h.client.state(h.target).snapshot.items[0]?.state, "submitted");
    assert.ok(h.container.textContent?.includes("already in the transcript"), "the server receipt must not erase the only visible copy before history arrives");
    await h.showReplies({ ...session, agent: provider, provider_resume: { provider, session_id: "fixture-thread" } }, [
      { id: "first-user-turn", role: "user", text: "already in the transcript", timestamp: new Date(3).toISOString() },
    ]);
    assert.ok(!h.container.textContent?.includes("already in the transcript"), "the transcript takes over the bubble once it proves this reply");
    const laterWindow: HistoryMessage[] = Array.from({ length: 50 }, (_, index) => ({
      id: `later-${index}`, role: "assistant", text: `Later progress ${index}`, timestamp: new Date(10 + index).toISOString(),
    }));
    await h.showReplies({ ...session, agent: provider }, laterWindow);
    assert.ok(!h.container.textContent?.includes("already in the transcript"), "a later history page must not resurrect the settled reply");
    await h.close();
    h = await fixture(factory, false);
    h.online(false);
    await h.client.ready;
    assert.equal(h.client.state(h.target).snapshot.items[0]?.id, id, "the retained server row still exists after client remount");
    await h.showReplies({ ...session, agent: provider }, []);
    assert.ok(!h.container.textContent?.includes("already in the transcript"), "remount with unloaded history must preserve the handover");
  } finally { await h.close(); }
});

for (const provider of ["claude", "codex"] as const) test(`#54 submitted ${provider} image replies hand over durably without clearing unrelated replies`, async () => {
  const factory = new IDBFactory();
  let h = await fixture(factory, false);
  try {
    const id = crypto.randomUUID(), other = crypto.randomUUID();
    const item = (id: string, text: string): SharedOutboxItem => ({
      id, text, state: "submitted", revision: 3, session_incarnation: "inc-1",
      created_at: 1, updated_at: 2, request_id: id, edit_hold: null, error_code: null,
      receipt: { request_id: id, session_id: session.id, session_incarnation: "inc-1", outcome: "submitted", code: null },
    });
    const path = "'/attachments/example.png'";
    await h.ownServer({ revision: 3, compose_holds: [], items: [item(id, path), item(other, "Keep this reply")] });
    await h.client.sync(h.target);
    const active = { ...session, agent: provider, provider_resume: { provider, session_id: "fixture-thread" } };
    await h.showReplies(active, []);
    assert.ok(h.container.textContent?.includes(path), "receipt alone keeps the echo");
    const turn: HistoryMessage = { id: "image-turn", role: "user", text: provider === "claude" ? "[Image #1]" : "",
      images: [{ id: "synthetic-image" }], timestamp: new Date(3).toISOString() };
    await h.showReplies(active, [turn]);
    assert.ok(!h.container.textContent?.includes(path), "image turn takes over the echo");
    assert.ok(h.container.textContent?.includes("Keep this reply"), "unrelated submitted reply remains visible");
    await h.close(); h = await fixture(factory, false); h.online(false); await h.client.ready;
    await h.showReplies(active, []);
    assert.ok(!h.container.textContent?.includes(path), "handover survives restart and unloaded history");
    assert.ok(h.container.textContent?.includes("Keep this reply"));
    const second = crypto.randomUUID();
    await h.ownServer({ revision: 4, compose_holds: [], items: [item(id, path), item(second, path)] });
    h.online(true); await h.client.sync(h.target); await h.showReplies(active, [turn]);
    assert.equal(h.client.state(h.target).snapshot.items[1]?.id, second);
    assert.ok(h.container.textContent?.includes(path), "the duplicate stays visible");
    assert.equal(h.container.querySelectorAll(".history-outgoing-reply").length, 1, "spent image turn cannot confirm another identical reply");
  } finally { await h.close(); }
});

test("a settled transcript part cannot hide another identical submitted reply", async () => {
  const h = await fixture(new IDBFactory(), false);
  try {
    const first = crypto.randomUUID(), second = crypto.randomUUID();
    const item = (id: string) => ({
      id, text: "same submitted text", state: "submitted" as const, revision: 3, session_incarnation: "inc-1",
      created_at: 1, updated_at: 2, request_id: id, edit_hold: null, error_code: null,
      receipt: { request_id: id, session_id: session.id, session_incarnation: "inc-1", outcome: "submitted" as const, code: null },
    });
    const messages: HistoryMessage[] = [{ id: "one-user-turn", role: "user", text: "same submitted text", timestamp: new Date(3).toISOString() }];
    await h.ownServer({ revision: 3, compose_holds: [], items: [item(first)] });
    await h.client.sync(h.target); await h.showReplies(session, messages);
    await h.ownServer({ revision: 4, compose_holds: [], items: [item(first), item(second)] });
    await h.client.sync(h.target); await h.showReplies(session, messages);
    assert.equal(h.container.querySelectorAll('.history-outgoing-reply[data-status="submitted"]').length, 1,
      "the turn already spent on the first reply must not settle a genuinely unconfirmed second reply");
  } finally { await h.close(); }
});

test("a replacement incarnation does not resurrect prior submitted replies", async () => {
  const h = await fixture(new IDBFactory(), false);
  try {
    const id = crypto.randomUUID(), requestId = crypto.randomUUID();
    await h.ownServer({ revision: 3, compose_holds: [], items: [{
      id, text: "previous incarnation submitted reply", state: "submitted", revision: 3, session_incarnation: "inc-1",
      created_at: 1, updated_at: 2, request_id: requestId, edit_hold: null, error_code: null,
      receipt: { request_id: requestId, session_id: session.id, session_incarnation: "inc-1", outcome: "submitted", code: null },
    }] });
    await h.client.sync(h.target);
    await h.showReplies({ ...session, session_incarnation: "inc-2" });
    assert.ok(!h.container.textContent?.includes("previous incarnation submitted reply"), "completed history from a prior runtime must stay out of its replacement");
  } finally { await h.close(); }
});

// One send model for every harness: each scenario ends in the same visible
// state for Claude and Codex (#1033 acceptance). Post-send cancel is retired,
// so "cancel" checks that a sent bubble offers no action for either.
type Harness = Awaited<ReturnType<typeof fixture>>;
const contract: Record<string, { run(h: Harness, s: typeof session): Promise<void>; bubbles: string[]; submissions: number }> = {
  send: { bubbles: ["contract send"], submissions: 1, async run(h, s) {
    await h.client.enqueue(s, "contract send"); await h.client.sync(h.target);
  } },
  reply: { bubbles: [], submissions: 1, async run(h, s) {
    const id = await h.client.enqueue(s, "contract reply"); await h.client.sync(h.target);
    const now = h.snapshot(), request_id = crypto.randomUUID();
    await h.ownServer({ ...now, revision: now.revision + 1, items: now.items.map(item => item.id === id ? { ...item, state: "submitted" as const,
      revision: item.revision + 1, request_id, receipt: { request_id, session_id: s.id, session_incarnation: "inc-1", outcome: "submitted" as const, code: null } } : item) });
    await h.client.sync(h.target);
    h.messages([{ id: "reply-turn", role: "user", text: "contract reply", timestamp: new Date().toISOString() }]);
  } },
  cancel: { bubbles: ["contract cancel"], submissions: 1, async run(h, s) {
    await h.client.enqueue(s, "contract cancel"); await h.client.sync(h.target); await h.showReplies(s);
    const bubble = h.container.querySelector<HTMLElement>(".history-outgoing-bubble");
    await act(async () => bubble?.click()); await h.settle();
  } },
  reconnect: { bubbles: ["contract reconnect"], submissions: 1, async run(h, s) {
    h.online(false); await h.client.enqueue(s, "contract reconnect"); await h.settle();
    h.online(true); await h.client.sync(h.target); await h.client.sync(h.target);
  } },
  "duplicate send": { bubbles: ["contract duplicate"], submissions: 1, async run(h, s) {
    h.mode("lost-put"); await h.client.enqueue(s, "contract duplicate"); await h.client.sync(h.target); await h.settle();
    h.mode("normal"); await h.client.sync(h.target); await h.client.sync(h.target);
  } },
};
for (const [name, scenario] of Object.entries(contract)) test(`shared reply contract: ${name} ends in the same visible state for Claude and Codex`, async () => {
  const seen: Record<string, unknown> = {};
  for (const provider of ["claude", "codex"] as const) {
    const h = await fixture(new IDBFactory(), false);
    try {
      const shown = { ...session, agent: provider, provider_resume: { provider, session_id: "fixture-thread" } };
      await scenario.run(h, shown); await h.showReplies(shown);
      seen[provider] = {
        bubbles: [...h.container.querySelectorAll(".history-outgoing-text")].map(node => node.textContent),
        notes: [...h.container.querySelectorAll(".history-outgoing-note, .history-outgoing-status")].map(node => node.textContent),
        controls: h.container.querySelectorAll('button, textarea, [role="menu"]').length,
        submissions: h.admissions.length, edits: h.patches.length,
      };
    } finally { await h.close(); }
  }
  assert.deepEqual(seen.codex, seen.claude, "Codex and Claude must show the same state");
  assert.deepEqual(seen.claude, { bubbles: scenario.bubbles, notes: [], controls: 0, submissions: scenario.submissions, edits: 0 });
});

for (const online of [false, true]) test(`failed-turn resend is offered once while its shared intention is ${online ? "server queued" : "local"}`, async () => {
  const h = await fixture(new IDBFactory(), false);
  try {
    h.online(online); await h.showFailedComposer();
    const resend = () => [...h.container.querySelectorAll("button")].find(button => button.textContent === "Resend");
    assert.ok(resend());
    await act(async () => resend()!.click()); await h.settle();
    assert.equal(h.client.state(h.target).admissions.length + h.client.state(h.target).snapshot.items.length, 1);
    assert.ok(!resend(), "the same failed-turn action must disappear while its shared reply is outstanding");
  } finally { await h.close(); }
});

test("a refused shared reply does not hide the failed-turn resend", async () => {
  const h = await fixture(new IDBFactory(), false);
  try {
    const id = crypto.randomUUID(), requestId = crypto.randomUUID();
    await h.ownServer({ revision: 2, compose_holds: [], items: [{
      id, text: "refused by the provider", state: "refused", revision: 2, session_incarnation: "inc-1",
      created_at: 1, updated_at: 2, request_id: requestId, edit_hold: null, error_code: "session-blocked",
      receipt: { request_id: requestId, session_id: session.id, session_incarnation: "inc-1", outcome: "refused", code: "session-blocked" },
    }] });
    await h.client.sync(h.target); await h.showFailedComposer();
    assert.ok([...h.container.querySelectorAll("button")].some(button => button.textContent === "Resend"),
      "a reply that was never handed off must not hold back the resend");
  } finally { await h.close(); }
});


test("a replaced shared cookie cannot move a retained intention into another account", async () => {
  const h = await fixture(new IDBFactory(), false);
  try {
    h.online(false);
    const id = await h.client.enqueue(session, "Alice retained text");
    h.remotePrincipal("root"); h.online(true);
    await h.client.sync(h.target);
    assert.equal(h.principalHeaders.at(-1), "alice", "the request asserts the original JavaScript principal");
    assert.deepEqual(h.admissions, []);
    assert.equal(h.client.state(h.target).admissions[0]?.id, id);
    assert.equal(h.client.state(h.target).admissions[0]?.attempted, false);
    assert.match(h.client.error(h.target) ?? "", /account changed.*sign in/i);
    h.remotePrincipal("alice");
    await h.client.sync(h.target);
    assert.deepEqual(h.admissions, [{ id, text: "Alice retained text" }]);
    assert.ok(h.principalHeaders.every(value => value === "alice"));
  } finally { await h.close(); }
});

test("a shared composer draft refusal explains safe recovery without automatic retry", async () => {
  const h = await fixture(new IDBFactory(), false);
  try {
    const requestId = crypto.randomUUID();
    await h.ownServer({ revision: 2, compose_holds: [], items: [{
      id: "draft-refusal", text: "preserved reply", state: "refused", revision: 2,
      session_incarnation: "inc-1", created_at: 1, updated_at: 2, request_id: requestId,
      edit_hold: null, error_code: "composer-not-empty",
      receipt: { request_id: requestId, session_id: session.id, session_incarnation: "inc-1",
        outcome: "refused", code: "composer-not-empty" },
    }] });
    await h.client.sync(h.target);
    await h.showReplies();
    const refused = h.container.querySelector('[data-status="refused"]');
    assert.ok(refused);
    assert.match(refused.querySelector('[role="alert"]')?.textContent ?? "", /Terminal has a draft/);
    assert.match(refused.querySelector('[role="alert"]')?.textContent ?? "", /Clear it in the terminal, then Retry/);
    assert.match(refused.textContent ?? "", /preserved reply/);
    await act(async () => h.client.sync(h.target));
    assert.equal(h.admissions.length, 0, "a refusal never automatically resubmits the text");
    assert.equal(h.patches.length, 0, "showing recovery never clears or retries the draft");
  } finally { await h.close(); }
});

for (const [code, expected] of [
  ["busy", 'Not sent: messages that start with "/" are sent as commands and need the session to be idle. Retry when it is idle.'],
  ["auth-quarantined", "This message was not sent."],
] as const) test(`a shared reply refused as ${code} shows its own text and keeps Retry and Discard`, async () => {
  const h = await fixture(new IDBFactory(), false);
  try {
    const item: SharedOutboxItem = { id: `refused-${code}`, text: "/status", state: "refused", revision: 2,
      session_incarnation: "inc-1", created_at: 1, updated_at: 2, request_id: null, receipt: null, edit_hold: null, error_code: code };
    await h.ownServer({ revision: 2, items: [item], compose_holds: [] });
    await h.client.sync(h.target);
    await h.showReplies();
    const refused = h.container.querySelector('[data-status="refused"]');
    assert.ok(refused);
    assert.equal(refused.querySelector('[role="alert"]')?.textContent, expected);
    const labels = [...refused.querySelectorAll("button")].map(node => node.textContent);
    assert.ok(labels.includes("Retry") && labels.includes("Discard"));
  } finally { await h.close(); }
});

for (const current of [true, false]) test(`refused shared reply offers global Discard and ${current ? "Retry" : "no Retry for a prior incarnation"}`, async () => {
  const h = await fixture(new IDBFactory(), false);
  try {
    const item: SharedOutboxItem = { id: "refused-action", text: "unsent reply", state: "refused", revision: 2,
      session_incarnation: "inc-1", created_at: 1, updated_at: 2, request_id: null, receipt: null, edit_hold: null, error_code: "auth-quarantined" };
    await h.ownServer({ revision: 2, items: [item], compose_holds: [] });
    await h.client.sync(h.target);
    await h.showReplies(current ? session : { ...session, session_incarnation: "inc-2" });
    const button = (label: string) => [...h.container.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === label);
    assert.ok(button("Discard"), "a refused reply can be discarded without sending it");
    assert.equal(Boolean(button("Retry")), current);
    if (current) {
      await act(async () => button("Retry")!.click()); await h.settle();
      assert.equal(h.snapshot().items[0]?.state, "queued");
      assert.equal(h.admissions.length, 0, "retry mutates the existing refused intent rather than duplicating it");
      await h.ownServer({ revision: 4, items: [{ ...item, revision: 4 }], compose_holds: [] });
      await act(async () => h.client.sync(h.target)); await h.settle();
    }
    await act(async () => button("Discard")!.click()); await h.settle();
    assert.equal(h.snapshot().items[0]?.state, "cancelled");
    assertNoElement(h.container, '[data-status="refused"]', "discard removes the refused bubble after server confirmation");
    assert.equal(h.admissions.length, 0);
  } finally { await h.close(); }
});

test("the sender retains its own queued, uncertain, refused and submitted echoes across restart", async () => {
  const factory = new IDBFactory();
  let h = await fixture(factory, false);
  try {
    h.online(false);
    const id = await h.client.enqueue(session, "sender's retained reply");
    assert.deepEqual(h.client.state(h.target).localIntentIds, [id], "ownership is durable before upload");
    await h.close(); h = await fixture(factory, false);
    h.online(true); await h.client.sync(h.target);
    assert.deepEqual(h.admissions, [{ id, text: "sender's retained reply" }]);
    let snapshot = h.snapshot();
    const requestId = crypto.randomUUID();
    for (const state of ["queued", "unknown", "refused", "submitted"] as const) {
      snapshot = { ...snapshot, revision: snapshot.revision + 1, items: snapshot.items.map(item => ({ ...item, state,
        request_id: state === "queued" ? null : requestId,
        receipt: state === "queued" ? null : { request_id: requestId, session_id: session.id, session_incarnation: "inc-1", outcome: state,
          code: state === "submitted" ? null : state === "unknown" ? "structured-prompt-outcome-unknown" : "session-blocked" },
      })) };
      h.server(snapshot); await act(async () => h.client.sync(h.target)); await h.showReplies();
      assert.match(h.container.textContent ?? "", /sender's retained reply/, `${state}: the sender keeps its echo`);
      await h.close(); h = await fixture(factory, false); h.server(snapshot);
      await h.client.sync(h.target); await h.showReplies();
      assert.match(h.container.textContent ?? "", /sender's retained reply/, `${state}: restart preserves sender visibility`);
      assert.deepEqual(h.requests.filter(method => method !== "GET"), [], "restart never replays an admitted send");
    }
    await h.showReplies(session, [{ id: "sender-turn", role: "user", text: "sender's retained reply", timestamp: new Date().toISOString() }]);
    assertNoElement(h.container, ".history-outgoing-reply", "only matching history takes over a known sender's submitted echo");
    assert.deepEqual(h.client.state(h.target).snapshot, snapshot, "handover leaves authoritative rows intact");
  } finally { await h.close(); }
});

for (const state of ["submitted", "queued", "sending", "unknown", "refused"] as const) {
  test(`pre-ownership cached ${state} rows are ${state === "submitted" ? "excluded" : "preserved"} across reconnect and restart`, async () => {
    const factory = new IDBFactory();
    let h = await fixture(factory, false);
    try {
      const id = crypto.randomUUID(), requestId = crypto.randomUUID();
      const item: SharedOutboxItem = { id, text: "Unattributed cached reply", state, revision: 2,
        session_incarnation: "inc-1", created_at: 1, updated_at: 2, edit_hold: null, error_code: null,
        request_id: state === "queued" ? null : requestId,
        receipt: state === "submitted" || state === "unknown" || state === "refused"
          ? { request_id: requestId, session_id: session.id, session_incarnation: "inc-1", outcome: state,
            code: state === "submitted" ? null : state === "unknown" ? "structured-prompt-outcome-unknown" : "session-blocked" } : null };
      const snapshot = { revision: 2, items: [item], compose_holds: [] };
      const { localIntentIds: _local, unattributedIntentIds: _unattributed, ...legacy } = h.client.state(h.target);
      await h.cacheJournal({ ...legacy, snapshot });
      await h.close(); h = await fixture(factory, false); h.server(snapshot);
      for (let attempt = 0; attempt < 2; attempt++) {
        await h.client.sync(h.target); await h.showReplies();
        assert.equal(h.container.querySelectorAll(".history-outgoing-reply").length, state === "submitted" ? 0 : 1);
        assert.deepEqual(h.client.state(h.target).snapshot, snapshot, "projection does not delete or rewrite the cached server rows");
        assert.deepEqual(h.requests.filter(method => method !== "GET"), [], "compatibility never replays or mutates the row");
        if (attempt === 0) { await h.close(); h = await fixture(factory, false); h.server(snapshot); }
      }
      if (state === "unknown") {
        h.server({ ...snapshot, revision: 3, items: [{ ...item, state: "submitted", receipt: { ...item.receipt!, outcome: "submitted", code: null } }] });
        await act(async () => h.client.sync(h.target)); await h.showReplies();
        assertNoElement(h.container, ".history-outgoing-reply", "server confirmation reconciles the legacy uncertain row");
      }
      h.server({ ...h.snapshot(), revision: h.snapshot().revision + 1, items: [] });
      await act(async () => h.client.sync(h.target));
      assert.deepEqual(h.client.state(h.target).unattributedIntentIds, [], "a newer authoritative removal prunes legacy attribution");
    } finally { await h.close(); }
  });
}

test("a pre-ownership local admission remains owned when a lost acknowledgement is reconciled", async () => {
  const factory = new IDBFactory();
  let h = await fixture(factory, false);
  try {
    const id = crypto.randomUUID(), requestId = crypto.randomUUID(), text = "Known legacy local intent";
    const { localIntentIds: _local, unattributedIntentIds: _unattributed, ...legacy } = h.client.state(h.target);
    await h.cacheJournal({ ...legacy, admissions: [{ id, text, created_at: 1, attempted: true }] });
    await h.close(); h = await fixture(factory, false);
    h.server({ revision: 3, compose_holds: [], items: [{ id, text, state: "submitted", revision: 3,
      session_incarnation: "inc-1", created_at: 1, updated_at: 2, request_id: requestId, edit_hold: null, error_code: null,
      receipt: { request_id: requestId, session_id: session.id, session_incarnation: "inc-1", outcome: "submitted", code: null } }] });
    await h.client.sync(h.target); await h.showReplies();
    assert.deepEqual(h.client.state(h.target).localIntentIds, [id]);
    assert.equal(h.client.state(h.target).admissions.length, 0);
    assert.match(h.container.textContent ?? "", /Known legacy local intent/);
    assert.deepEqual(h.requests.filter(method => method !== "GET"), [], "server acknowledgement never replays the local admission");
  } finally { await h.close(); }
});

test("a delayed equal-revision snapshot cannot hide the sender's acknowledged queued reply", async () => {
  const factory = new IDBFactory(), h = await fixture(factory, false);
  const other = new h.module.SharedOutboxClient(h.client.namespace, factory);
  const deferred = () => { let release!: () => void; const ready = new Promise<void>(resolve => { release = resolve; }); return { ready, release }; };
  const putStarted = deferred(), allowPut = deferred(), staleStarted = deferred(), allowStale = deferred(), freshStarted = deferred(), allowFresh = deferred();
  const transport = globalThis.fetch;
  let reads = 0;
  globalThis.fetch = async (input, init) => {
    const method = init?.method ?? "GET";
    if (method === "PUT") { putStarted.release(); await allowPut.ready; }
    const response = await transport(input, init);
    if (method === "GET") {
      const ordinal = ++reads;
      if (ordinal === 2) { staleStarted.release(); await allowStale.ready; }
      if (ordinal === 3) { freshStarted.release(); await allowFresh.ready; }
    }
    return response;
  };
  try {
    await other.ready;
    const id = await h.client.enqueue(session, "Known queued reply"); await putStarted.ready;
    const delayed = other.sync(h.target); await staleStarted.ready;
    allowPut.release(); await freshStarted.ready;
    assert.deepEqual(h.client.state(h.target).localIntentIds, [id], "the acknowledged local intent is still owned");
    allowStale.release(); await delayed;
    allowFresh.release(); await h.client.sync(h.target);
    assert.equal(other.error(h.target), undefined, "the delayed response completes without a fixture timeout");
    assert.equal(h.client.state(h.target).snapshot.items[0]?.state, "queued");
    await h.showReplies();
    assert.match(h.container.textContent ?? "", /Known queued reply/, "fresh server state must restore the known sender's visible reply");
    assert.deepEqual(h.client.state(h.target).localIntentIds, [id]);
    assert.equal(h.admissions.length, 1, "concurrent snapshots never replay the intention");
    h.server({ ...h.snapshot(), revision: h.snapshot().revision + 1, items: [] });
    await act(async () => h.client.sync(h.target));
    assert.deepEqual(h.client.state(h.target).localIntentIds, [], "a newer authoritative removal can retire the owned ID after acknowledgement");
  } finally {
    allowPut.release(); allowStale.release(); allowFresh.release(); globalThis.fetch = transport;
    other.close(); await h.close();
  }
});

const sharedItem = (id: string, text: string, state: "queued" | "unknown" | "refused" | "submitted", createdAt: number): SharedOutboxItem => ({
  id, text, state, revision: 3, session_incarnation: "inc-1", created_at: createdAt, updated_at: createdAt, edit_hold: null, error_code: null,
  request_id: state === "queued" ? null : id,
  receipt: state === "queued" ? null : { request_id: id, session_id: session.id, session_incarnation: "inc-1", outcome: state,
    code: state === "submitted" ? null : state === "unknown" ? "structured-prompt-outcome-unknown" : "session-blocked" },
});

// #110: a reply sent mid-turn is recorded by Claude Code as a queued_command
// attachment, stamped by the provider host; it can precede the edge's admission
// time for the same reply.

test("#181 a refused row whose text reached the transcript leaves no unsent bubble or Retry", async () => {
  const h = await fixture(new IDBFactory(), false);
  try {
    const id = crypto.randomUUID(), createdAt = Date.now(), sent = "reply delivered mid-turn";
    const refused = { ...sharedItem(id, sent, "refused", createdAt), error_code: "composer-unobservable" };
    await h.ownServer({ revision: 3, compose_holds: [], items: [refused] });
    await h.client.sync(h.target);
    const buttons = () => [...h.container.querySelectorAll("button")].map(button => button.textContent);
    await h.showReplies(session, []);
    assert.ok(buttons().includes("Retry"), "a genuine refusal keeps its Retry until history shows the text");
    await h.showReplies(session, [{ id: "other-turn", role: "user", text: "a different reply", timestamp: new Date(createdAt + 1000).toISOString() }]);
    assert.ok(buttons().includes("Retry"), "unrelated history proves nothing");
    const turn: HistoryMessage = { id: "delivered-turn", role: "user", text: sent, timestamp: new Date(createdAt + 1000).toISOString() };
    await h.showReplies(session, [turn]);
    assert.equal(h.container.querySelectorAll(".history-outgoing-reply").length, 0, "the delivered turn replaces the unsent bubble");
    assert.ok(!h.container.textContent?.includes("This message was not sent."));
    await h.showReplies(session, []);
    assert.equal(h.container.querySelectorAll(".history-outgoing-reply").length, 0, "the proof outlives a reloaded history page");
    assert.ok(h.requests.every(method => method === "GET"), "nothing is sent again");
  } finally { await h.close(); }
});

test("#181 the same text sent twice keeps Retry on the genuine refusal until a second turn exists", async () => {
  const h = await fixture(new IDBFactory(), false);
  try {
    const delivered = crypto.randomUUID(), refused = crypto.randomUUID(), createdAt = Date.now(), sent = "same reply text";
    await h.ownServer({ revision: 3, compose_holds: [], items: [
      { ...sharedItem(refused, sent, "refused", createdAt + 500), error_code: "composer-unobservable" },
      sharedItem(delivered, sent, "submitted", createdAt),
    ] });
    await h.client.sync(h.target);
    const first: HistoryMessage = { id: "first-turn", role: "user", text: sent, timestamp: new Date(createdAt + 100).toISOString() };
    await h.showReplies(session, [first]);
    assert.equal(h.container.querySelectorAll('.history-outgoing-reply[data-status="refused"]').length, 1, "one turn proves one row");
    assert.equal(h.container.querySelectorAll('.history-outgoing-reply[data-status="submitted"]').length, 0, "the delivered row owns that turn");
    assert.ok([...h.container.querySelectorAll("button")].some(button => button.textContent === "Retry"));
    await h.showReplies(session, [first, { id: "second-turn", role: "user", text: sent, timestamp: new Date(createdAt + 1000).toISOString() }]);
    assert.equal(h.container.querySelectorAll(".history-outgoing-reply").length, 0, "a second turn is the second delivery");
  } finally { await h.close(); }
});

test("#181 a turn outside the attempt window does not prove a refused row", async () => {
  const h = await fixture(new IDBFactory(), false);
  try {
    const id = crypto.randomUUID(), createdAt = Date.now() - 3_600_000, sent = "repeated much later";
    await h.ownServer({ revision: 3, compose_holds: [], items: [{ ...sharedItem(id, sent, "refused", createdAt), error_code: "composer-unobservable" }] });
    await h.client.sync(h.target);
    await h.showReplies(session, [{ id: "later-turn", role: "user", text: sent, timestamp: new Date(createdAt + 3_000_000).toISOString() }]);
    assert.ok([...h.container.querySelectorAll("button")].some(button => button.textContent === "Retry"));
  } finally { await h.close(); }
});

test("#181 a reply saved before the client went inactive resolves, so the composer cannot make a second intent", async () => {
  const h = await fixture(new IDBFactory(), false);
  const storage = await h.ssr.loadModule<typeof import("../src/storage.ts")>("/src/storage.ts");
  const put = IDBObjectStore.prototype.put;
  try {
    // The account or connection changes while the journal write commits, after
    // the transaction's last active check.
    IDBObjectStore.prototype.put = function (...args) {
      IDBObjectStore.prototype.put = put; storage.setPrincipalStorageNamespace("bob");
      return put.apply(this, args);
    };
    const id = await h.client.enqueue(session, "saved while the connection changed");
    storage.setPrincipalStorageNamespace("alice");
    await h.client.sync(h.target); await h.client.sync(h.target);
    assert.deepEqual(h.admissions.map(item => item.id), [id], "the durable intent uploads once under its own id");
  } finally { IDBObjectStore.prototype.put = put; storage.setPrincipalStorageNamespace("alice"); await h.close(); }
});

test("#181 a failed-turn resend saved while inactive stays pending before any reload", async () => {
  const h = await fixture(new IDBFactory(), false);
  const storage = await h.ssr.loadModule<typeof import("../src/storage.ts")>("/src/storage.ts");
  const put = IDBObjectStore.prototype.put;
  try {
    // The dashboard keeps the client started, so returning to it waits for the
    // poll interval instead of ticking at once.
    const stop = h.client.start();
    h.online(false); await h.showFailedComposer();
    const resend = () => [...h.container.querySelectorAll("button")].find(button => button.textContent === "Resend");
    IDBObjectStore.prototype.put = function (...args) {
      IDBObjectStore.prototype.put = put; storage.setPrincipalStorageNamespace("bob");
      return put.apply(this, args);
    };
    await act(async () => resend()!.click()); await h.settle();
    storage.setPrincipalStorageNamespace("alice");
    await h.showFailedComposer();
    assert.ok(!resend(), "the same principal sees the durable intent before its next reload");
    assert.equal(h.client.state(h.target).admissions.length, 1);
    assert.ok(!h.requests.includes("PUT"), "an inactive client uploads nothing");
    stop();
  } finally { IDBObjectStore.prototype.put = put; storage.setPrincipalStorageNamespace("alice"); await h.close(); }
});

test("#181 a late unknown reply whose turn is in the transcript is reconciled without a resend", async () => {
  const h = await fixture(new IDBFactory(), false);
  try {
    const id = crypto.randomUUID(), createdAt = Date.now(), sent = "reply whose acknowledgement timed out";
    await h.ownServer({ revision: 3, compose_holds: [], items: [sharedItem(id, sent, "unknown", createdAt)] });
    await h.client.sync(h.target);
    await h.showReplies(session, [{ id: "late-turn", role: "user", text: sent, timestamp: new Date(createdAt + 1000).toISOString() }]);
    assert.equal(h.container.querySelectorAll(".history-outgoing-reply").length, 0, "history confirms the uncertain reply");
    assert.ok(h.requests.every(method => method === "GET"), "nothing is sent again");
  } finally { await h.close(); }
});

test("#110 a mid-turn reply's transcript turn stamped before its admission clears the pending bubble", async () => {
  const h = await fixture(new IDBFactory(), false);
  try {
    const id = crypto.randomUUID(), sent = "typed first\nthen a paste";
    const createdAt = Date.now();
    await h.ownServer({ revision: 3, compose_holds: [], items: [sharedItem(id, sent, "submitted", createdAt)] });
    await h.client.sync(h.target);
    await h.showReplies(session, []);
    assert.ok(h.container.textContent?.includes("then a paste"), "the echo shows until the transcript has the turn");
    const turn: HistoryMessage = { id: "queued-turn", role: "user", timestamp: new Date(createdAt - 150).toISOString(),
      text: '\n\ntyped first\n<pasted_content id="a1b2">\nthen a paste\n</pasted_content id="a1b2">\n' };
    await h.showReplies(session, [turn]);
    assert.equal(h.container.querySelectorAll(".history-outgoing-reply").length, 0, "the transcript turn took over the bubble");
    assert.ok(h.requests.every(method => method === "GET"), "nothing is sent again");
  } finally { await h.close(); }
});

test("#110 a pending bubble is dismissed from its context menu, only locally, and stays dismissed", async () => {
  const factory = new IDBFactory();
  let h = await fixture(factory, false);
  try {
    const stuck = crypto.randomUUID(), uncertain = crypto.randomUUID(), refused = crypto.randomUUID(), queued = crypto.randomUUID();
    await h.ownServer({ revision: 5, compose_holds: [], items: [
      sharedItem(stuck, "stuck submitted reply", "submitted", Date.now()), sharedItem(uncertain, "stuck uncertain reply", "unknown", Date.now()),
      sharedItem(refused, "refused reply", "refused", Date.now()), sharedItem(queued, "queued reply", "queued", Date.now())] });
    await h.client.sync(h.target);
    await h.showReplies(session, []);
    const mutations = () => h.requests.filter(method => method !== "GET").length;
    const before = mutations();
    await openReplyMenu(h.container, "refused reply"); assert.equal(replyMenuItem(), undefined, "a refused reply keeps Discard and Retry");
    await openReplyMenu(h.container, "queued reply"); assert.equal(replyMenuItem(), undefined, "an unsent reply is not dismissible");
    await openReplyMenu(h.container, "stuck submitted reply");
    await act(async () => replyMenuItem()!.click()); await h.settle();
    await openReplyMenu(h.container, "stuck uncertain reply");
    await act(async () => replyMenuItem()!.click()); await h.settle();
    assert.ok(!h.container.textContent?.includes("stuck submitted reply") && !h.container.textContent?.includes("stuck uncertain reply"));
    assert.ok(h.container.textContent?.includes("refused reply") && h.container.textContent?.includes("queued reply"));
    assert.equal(mutations(), before, "dismissing sends, cancels and edits nothing on the server");
    assert.equal(h.snapshot().items.length, 4, "the server rows are untouched");
    await h.close(); h = await fixture(factory, false); h.online(false); await h.client.ready;
    await h.showReplies(session, []);
    assert.ok(!h.container.textContent?.includes("stuck submitted reply"), "the dismissal survives a restart");
    assert.ok(h.container.textContent?.includes("queued reply"));
  } finally { await h.close(); }
});
