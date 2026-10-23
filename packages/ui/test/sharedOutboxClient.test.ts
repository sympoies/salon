import { strict as assert } from "node:assert";
import { test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Plugin } from "vite";
import type { SharedOutboxItem, SharedOutboxSnapshot } from "@agent-console/shared/shared-outbox";
import { makeSession } from "./support/fixtures.ts";
import { createUiSsrHarness } from "./support/ssr.ts";
import { assertNoElement } from "./support/domAssert.ts";

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
          ...(body.operation === "cancel" ? { state: "cancelled" as const } : {}),
          ...(body.operation === "begin_edit" ? { edit_hold: body.hold_id } : {}),
          ...(body.operation === "release_edit" || body.operation === "save_edit" ? { edit_hold: null } : {}),
          ...(body.operation === "save_edit" ? { text: body.text } : {}) };
        snapshot = { ...snapshot, revision: snapshot.revision + 1, items: snapshot.items.map(item => item.id === intent ? changed : item) };
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
    async showReplies(shown = session) {
      const { SharedOutgoingReplies } = await ssr.loadModule<typeof import("../src/SharedOutgoingReplies.tsx")>("/src/SharedOutgoingReplies.tsx");
      await act(async () => root.render(createElement(SharedOutgoingReplies, { session: shown }))); await settle();
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
    server(value: SharedOutboxSnapshot) { snapshot = value; },
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
    h.server({ revision: 4, compose_holds: [], items: [{
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

// The transcript shows a submitted message; a second bubble would repeat it.
for (const provider of ["codex", "claude"] as const) test(`a submitted ${provider} reply leaves no outgoing bubble`, async () => {
  const h = await fixture(new IDBFactory(), false);
  try {
    const id = crypto.randomUUID(), requestId = crypto.randomUUID();
    h.server({ revision: 3, compose_holds: [], items: [{
      id, text: "already in the transcript", state: "submitted", revision: 3, session_incarnation: "inc-1",
      created_at: 1, updated_at: 2, request_id: requestId, edit_hold: null, error_code: null,
      receipt: { request_id: requestId, session_id: session.id, session_incarnation: "inc-1", outcome: "submitted", code: null },
    }] });
    await h.client.sync(h.target);
    await h.showReplies({ ...session, agent: provider, provider_resume: { provider, session_id: "fixture-thread" } });
    assert.equal(h.client.state(h.target).snapshot.items[0]?.state, "submitted");
    assert.ok(!h.container.textContent?.includes("already in the transcript"), "a submitted reply must not be shown again below the transcript");
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
    h.server({ ...now, revision: now.revision + 1, items: now.items.map(item => item.id === id ? { ...item, state: "submitted" as const,
      revision: item.revision + 1, request_id, receipt: { request_id, session_id: s.id, session_incarnation: "inc-1", outcome: "submitted" as const, code: null } } : item) });
    await h.client.sync(h.target);
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
    h.server({ revision: 2, compose_holds: [], items: [{
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
