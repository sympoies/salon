import { strict as assert } from "node:assert";
import { test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { Window } from "happy-dom";
import type { Plugin } from "vite";
import { makeSession } from "./support/fixtures.ts";
import { createUiSsrHarness } from "./support/ssr.ts";

declare global {
  var __sharedNativeReady: Promise<void> | undefined;
  var __sharedNativeLoading: (() => void) | undefined;
  var __sharedNativeCalls: unknown[] | undefined;
}

for (const replacement of ["server", "credential"] as const) test(`shared admission never uses a replacement native ${replacement} during transport loading`, async () => {
  const window = new Window({ url: "http://tauri.localhost" }), factory = new IDBFactory();
  const globals = { window, navigator: window.navigator, document: window.document, localStorage: window.localStorage, indexedDB: factory };
  const saved = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  let release = () => {}, loaded = () => {};
  globalThis.__sharedNativeReady = new Promise<void>(resolve => { release = resolve; });
  const loading = new Promise<void>(resolve => { loaded = resolve; });
  globalThis.__sharedNativeLoading = loaded; globalThis.__sharedNativeCalls = [];
  const boundary: Plugin = {
    name: "shared-native-transport", enforce: "pre",
    resolveId(id) { if (id === "@tauri-apps/plugin-http") return "\0shared-native-http"; },
    load(id) { if (id === "\0shared-native-http") return `globalThis.__sharedNativeLoading();await globalThis.__sharedNativeReady;
      export async function fetch(url,init){globalThis.__sharedNativeCalls.push({url,method:init.method});
      return Response.json({ok:true,data:{revision:0,items:[],compose_holds:[]}});}`; },
  };
  const harness = createUiSsrHarness({ plugins: [boundary], ssr: { noExternal: ["@tauri-apps/plugin-http"] } });
  let client: { close(): void } | undefined;
  try {
    const runtime = await harness.loadModule<typeof import("../src/runtime.ts")>("/src/runtime.ts");
    runtime.saveServerUrl("https://fixture-a.invalid"); runtime.saveToken("fixture-token-a");
    runtime.recordNativeAuthentication(runtime.nativeConnectionConfigGeneration(), true, "alice");
    const storage = await harness.loadModule<typeof import("../src/storage.ts")>("/src/storage.ts");
    storage.setPrincipalStorageNamespace("alice");
    const module = await harness.loadModule<typeof import("../src/sharedOutboxClient.ts")>("/src/sharedOutboxClient.ts");
    const store = module.sharedOutboxClient(); client = store; await store.ready;
    const session = makeSession({ machine: "fixture", id: "native-shared", agent: "codex", session_incarnation: "inc-1" });
    Object.defineProperty(window.navigator, "onLine", { value: false, configurable: true });
    const id = await store.enqueue(session, "original native account text");
    Object.defineProperty(window.navigator, "onLine", { value: true, configurable: true });
    const sync = store.sync(module.sharedOutboxTarget(session));
    await Promise.race([loading, sync.then(() => { throw new Error("Synchronization finished before transport loaded"); })]);
    if (replacement === "server") runtime.saveServerUrl("https://fixture-b.invalid");
    else runtime.saveToken("fixture-token-b");
    release(); await sync;
    assert.deepEqual(globalThis.__sharedNativeCalls, []);
    assert.equal(store.state(module.sharedOutboxTarget(session)).admissions[0]?.id, id);
    assert.equal(store.state(module.sharedOutboxTarget(session)).admissions[0]?.attempted, false);
  } finally {
    release(); client?.close(); await harness.close();
    for (const [key, value] of saved) value ? Object.defineProperty(globalThis, key, value) : Reflect.deleteProperty(globalThis, key);
    delete globalThis.__sharedNativeReady; delete globalThis.__sharedNativeLoading; delete globalThis.__sharedNativeCalls;
    await window.happyDOM.close();
  }
});
