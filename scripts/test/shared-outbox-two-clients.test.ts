import { strict as assert } from "node:assert";
import { createServer, type Server } from "node:http";
import type { HistoryMessage } from "../../packages/ui/src/types.ts";
import type { SharedOutboxClient } from "../../packages/ui/src/sharedOutboxClient.ts";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
const uiRequire = createRequire(new URL("../../packages/ui/package.json", import.meta.url));
const { IDBFactory } = uiRequire("fake-indexeddb");
const { Window } = uiRequire("happy-dom");
const { act, createElement } = uiRequire("react");
const { createRoot } = uiRequire("react-dom/client");
import { createEdgeServer } from "../../packages/edge/src/server.ts";
import { listenOnLoopback, loginCookie, makeEdgeConfig } from "../../packages/edge/test/support.ts";
import { makeSession } from "../../packages/ui/test/support/fixtures.ts";
import { createUiSsrHarness } from "../../packages/ui/test/support/ssr.ts";

async function stop(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

// Real edge HTTP, durable server outbox, UI API, independent client journals
// and rendered outgoing rows. Only the provider endpoint is synthetic.
test("two clients reconcile delivered replies across history windows, reconnect and restart", async t => {
  const directory = mkdtempSync(join(tmpdir(), "salon-two-clients-"));
  const session = makeSession({ machine: "fixture", id: "session-a", agent: "codex", session_incarnation: "inc-a",
    provider_resume: { provider: "codex", session_id: "provider-a" } });
  const history: HistoryMessage[] = [];
  let releaseDelivery!: () => void, enteredDelivery!: () => void;
  const deliveryReady = new Promise<void>(resolve => { enteredDelivery = resolve; });
  const deliveryAllowed = new Promise<void>(resolve => { releaseDelivery = resolve; });
  const daemon = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/sessions") return void response.end(JSON.stringify({ ok: true, data: { sessions: [session] } }));
    if (request.url === "/sessions/session-a/prompt/v2" && request.method === "POST") {
      let raw = ""; for await (const chunk of request) raw += String(chunk);
      const body = JSON.parse(raw);
      if (history.length === 0) { enteredDelivery(); await deliveryAllowed; }
      history.push({ id: `user-${history.length}`, role: "user", text: body.text, timestamp: new Date().toISOString() });
      const receipt = { request_id: body.request_id, session_id: session.id, session_incarnation: session.session_incarnation,
        outcome: "submitted", code: null };
      return void response.end(JSON.stringify({ ok: true, data: { receipt, submitted: true, session_incarnation: session.session_incarnation } }));
    }
    response.writeHead(404); response.end(JSON.stringify({ ok: false, error: { code: "not-found" } }));
  });
  const upstream = await listenOnLoopback(daemon);
  const edge = createEdgeServer(makeEdgeConfig({ openAccess: false, clientToken: "synthetic-client-token",
    accessDbPath: join(directory, "state.sqlite"), machines: [{ name: "fixture", url: upstream.base, token: "synthetic-provider-token" }] }),
    { outboxPollIntervalMs: 20 });
  const { base } = await listenOnLoopback(edge);
  const cookie = await loginCookie(base, "synthetic-client-token");
  const nativeFetch = globalThis.fetch;
  const factoryA = new IDBFactory(), factoryB = new IDBFactory();
  const window = new Window({ url: base });
  const globals = { window, navigator: window.navigator, document: window.document, HTMLElement: window.HTMLElement,
    indexedDB: factoryB, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const headers = new Headers(init?.headers); headers.set("cookie", cookie); headers.set("origin", base);
      return nativeFetch(new URL(String(input), base), { ...init, headers });
    } };
  const saved = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const container = window.document.createElement("div"); window.document.body.append(container);
  let root = createRoot(container), ssr = createUiSsrHarness();
  let clientA!: SharedOutboxClient;
  let clientB!: SharedOutboxClient;
  const settle = async () => act(async () => { for (let n = 0; n < 30; n++) await new Promise(resolve => setImmediate(resolve)); });
  const load = async () => {
    const storage = await ssr.loadModule<typeof import("../../packages/ui/src/storage.ts")>("/src/storage.ts");
    storage.setPrincipalStorageNamespace("legacy");
    const module = await ssr.loadModule<typeof import("../../packages/ui/src/sharedOutboxClient.ts")>("/src/sharedOutboxClient.ts");
    clientB = module.sharedOutboxClient(); await clientB.ready;
    return module;
  };
  const render = async (messages: HistoryMessage[]) => {
    const { SharedOutgoingReplies } = await ssr.loadModule<typeof import("../../packages/ui/src/SharedOutgoingReplies.tsx")>("/src/SharedOutgoingReplies.tsx");
    await act(async () => root.render(createElement(SharedOutgoingReplies, { session, messages }))); await settle();
    return [...container.querySelectorAll(".history-outgoing-text")].map(node => node.textContent);
  };
  try {
    const module = await load(), target = module.sharedOutboxTarget(session);
    clientA = new module.SharedOutboxClient(module.sharedOutboxNamespace(), factoryA); await clientA.ready;
    const send = async (text: string) => {
      await act(async () => { await clientA.enqueue(session, text); await clientA.sync(target); });
      for (let n = 0; n < 300; n++) {
        await act(async () => { await clientA.sync(target); });
        if (clientA.state(target).snapshot.items.at(-1)?.state === "submitted") return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail("synthetic provider submission did not settle");
    };
    await act(async () => { await clientA.enqueue(session, "First synthetic request"); await clientA.sync(target); });
    await deliveryReady;
    await act(async () => { await clientB.sync(target); });
    assert.equal(clientB.state(target).snapshot.items[0]?.state, "sending");
    assert.deepEqual(await render([]), [], "an in-flight send from A is never B's outgoing echo");
    releaseDelivery();
    for (let n = 0; n < 300; n++) {
      await act(async () => { await clientA.sync(target); });
      if (clientA.state(target).snapshot.items[0]?.state === "submitted") break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(clientA.state(target).snapshot.items[0]?.state, "submitted");
    await act(async () => { await clientB.sync(target); });
    assert.equal(clientB.state(target).admissions.length, 0, "B never enqueued the send");
    assert.equal(clientB.state(target).snapshot.items[0]?.text, "First synthetic request", "A's send actually reaches B through the shared HTTP snapshot");
    assert.deepEqual(await render(history), [], "matching history reconciles B's copy");
    // B misses a turn while disconnected. The next latest page has moved on.
    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: false });
    await act(async () => root.render(null)); await settle();
    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: true });
    await send("Second synthetic request");
    await send("Third synthetic request");
    const latest = history.slice(-1);
    await act(async () => { await clientB.sync(target); });
    const reconnected = await render(latest);
    await act(async () => root.unmount()); clientB.close(); await ssr.close();
    root = createRoot(container); ssr = createUiSsrHarness(); await load();
    await act(async () => { await clientB.sync(target); });
    const restarted = await render(latest);
    t.diagnostic(JSON.stringify({ reconnected, restarted, providerSubmissions: history.length }));
    assert.equal(history.length, 3, "reconnect and restart must not replay a send");
    assert.deepEqual(reconnected, [], "B must not append another client's delivered replies outside its history window");
    assert.deepEqual(restarted, [], "B restart must not resurrect another client's pending copies");
  } finally {
    releaseDelivery();
    await act(async () => root.unmount()); clientA?.close(); clientB?.close(); await ssr.close();
    for (const [key, descriptor] of saved) descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
    await window.happyDOM.close(); await stop(edge); await stop(daemon); rmSync(directory, { recursive: true, force: true });
  }
});

import { archiveResumeOutbox } from "../../packages/edge/test/support/archiveResumeOutbox.ts";
test("#339 mounted archive/resume refusal keeps Discard and Retry through reload", async t => {
  const edge = await archiveResumeOutbox();
  t.after(() => edge.close());
  const session = makeSession({ machine: "fixture", id: "shared-reply", agent: "codex", session_incarnation: "inc-1",
    provider_resume: { provider: "codex", session_id: "fixture-thread" } });
  const replacement = { ...session, session_incarnation: "inc-2" };
  const factory = new IDBFactory(), window = new Window({ url: "http://localhost" }), nativeFetch = globalThis.fetch;
  const globals = { window, navigator: window.navigator, document: window.document, HTMLElement: window.HTMLElement,
    indexedDB: factory, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = new URL(String(input), "http://localhost");
      return url.hostname === "localhost" ? edge.request(`${url.pathname}${url.search}`, init) : nativeFetch(input, init);
    } };
  const saved = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const container = window.document.createElement("div"); window.document.body.append(container);
  let root = createRoot(container), ssr = createUiSsrHarness();
  let client!: SharedOutboxClient, module!: typeof import("../../packages/ui/src/sharedOutboxClient.ts");
  const settle = async () => act(async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); });
  const load = async () => {
    const storage = await ssr.loadModule<typeof import("../../packages/ui/src/storage.ts")>("/src/storage.ts"); storage.setPrincipalStorageNamespace("legacy");
    module = await ssr.loadModule<typeof import("../../packages/ui/src/sharedOutboxClient.ts")>("/src/sharedOutboxClient.ts"); client = module.sharedOutboxClient(); await client.ready;
  };
  const actions = () => [...container.querySelectorAll("button")].map(button => button.textContent);
  const refresh = async (shown = session) => {
    await act(async () => { await client.sync(module.sharedOutboxTarget(shown)); });
    const { SharedOutgoingReplies } = await ssr.loadModule<typeof import("../../packages/ui/src/SharedOutgoingReplies.tsx")>("/src/SharedOutgoingReplies.tsx");
    await act(async () => root.render(createElement(SharedOutgoingReplies, { session: shown }))); await settle();
  };
  try {
    await load();
    await act(async () => { await client.enqueue(session, "Earlier refused reply"); await client.sync(module.sharedOutboxTarget(session)); });
    await edge.until(async () => (await edge.list("inc-1")).items[0]?.state === "refused");
    await refresh();
    assert.ok(actions().includes("Discard") && actions().includes("Retry"), "never-resumed refusal has both actions");
    await edge.archiveAndResume();
    await act(async () => { await client.enqueue(replacement, "Current refused reply"); });
    await refresh(replacement);
    assert.doesNotMatch(container.textContent ?? "", /The reply changed on the server/, "new incarnation is not a revision conflict");
    await edge.until(async () => (await edge.list()).items[0]?.state === "refused");
    await edge.until(async () => (await edge.list("inc-1")).items[0]?.state === "cancelled");
    await act(async () => window.dispatchEvent(new window.Event("focus"))); await settle();
    await refresh(replacement);
    assert.ok(actions().includes("Discard") && actions().includes("Retry"));
    assert.match(container.textContent ?? "", /Terminal has a draft/);
    assert.doesNotMatch(container.textContent ?? "", /Earlier refused reply/);
    assert.equal(edge.posts(), 2);
    await act(async () => root.unmount()); client.close(); await ssr.close(); await edge.restart();
    root = createRoot(container); ssr = createUiSsrHarness(); await load();
    await refresh(replacement);
    assert.ok(actions().includes("Discard") && actions().includes("Retry"), "reload restores both actions");
    assert.doesNotMatch(container.textContent ?? "", /The reply changed on the server|Earlier refused reply/);
    const click = async (label: string) => {
      const button = [...container.querySelectorAll("button")].find(button => button.textContent === label);
      assert.ok(button); await act(async () => button.click()); await settle();
    };
    await click("Retry");
    await edge.until(async () => (await edge.list()).items[0]?.state === "refused" && edge.posts() === 3);
    await refresh(replacement);
    await click("Discard"); await refresh(replacement);
    assert.equal(container.querySelectorAll(".history-outgoing-reply").length, 0);
    assert.equal(edge.posts(), 3, "reload, stale-target polling and Discard never submit input");
  } finally {
    await act(async () => root.unmount()); client?.close(); await ssr.close();
    for (const [key, descriptor] of saved) descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
    await window.happyDOM.close();
  }
});
