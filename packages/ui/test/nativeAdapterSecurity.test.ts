import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Window } from "happy-dom";
import { createUiSsrHarness } from "./support/ssr.ts";

declare global { var __adapterSecurityFetch: ((url: string, init?: RequestInit) => Promise<Response>) | undefined; }

async function fixture() {
  const window = new Window({ url: "http://tauri.localhost" });
  const previous = globalThis.window;
  globalThis.window = window as unknown as typeof globalThis.window;
  const ssr = createUiSsrHarness({ ssr: { noExternal: ["@tauri-apps/plugin-http"] }, plugins: [{
    name: "adapter-security-transport", enforce: "pre",
    resolveId(id) { if (id === "@tauri-apps/plugin-http") return "\0adapter-security-transport"; },
    load(id) { if (id === "\0adapter-security-transport") return "export const fetch=(...args)=>globalThis.__adapterSecurityFetch(...args)"; },
  }] });
  const runtime = await ssr.loadModule<typeof import("../src/runtime.ts")>("/src/runtime.ts");
  return { runtime, window, async close() { globalThis.window = previous; delete globalThis.__adapterSecurityFetch; await ssr.close(); await window.happyDOM.close(); } };
}

test("pending and failed adapter saves do not advance connection identity", async () => {
  const f = await fixture();
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let fail = false;
  try {
    await f.runtime.registerNativeConnectionAdapter({ async load() { return { serverUrl: "https://old.example.test", token: "old" }; },
      async save() { entered(); await pending; if (fail) throw Error("storage unavailable"); } });
    const generation = f.runtime.nativeConnectionConfigGeneration();
    f.runtime.recordNativeAuthentication(generation, true, null);
    assert.equal(f.runtime.nativePrincipalIsActive(), true);
    const saving = f.runtime.saveConnectionValues("https://new.example.test", "new");
    await started;
    assert.equal(f.runtime.nativeConnectionConfigGeneration(), generation, "pending writes cannot claim the new connection generation");
    assert.equal(f.runtime.nativePrincipalIsActive(), false);
    let sent = "";
    globalThis.__adapterSecurityFetch = async (url) => { sent = url; return new Response("", { status: 200 }); };
    await f.runtime.appFetch("/api/sessions");
    assert.equal(new URL(sent).origin, "https://old.example.test");
    fail = true; release();
    await assert.rejects(saving!);
    assert.equal(f.runtime.nativeConnectionConfigGeneration(), generation);
    assert.equal(f.runtime.loadServerUrl(), "https://old.example.test");
    assert.equal(f.runtime.loadToken(), "old");
    assert.equal(f.runtime.nativePrincipalIsActive(), true, "a failed write restores the previous active connection");
  } finally { release(); await f.close(); }
});

test("authoritative 401 clears memory and notifies even when adapter storage fails", async () => {
  const f = await fixture();
  try {
    await f.runtime.registerNativeConnectionAdapter({ async load() { return { serverUrl: "https://old.example.test", token: "old" }; },
      async save() { throw Error("storage unavailable"); } });
    f.runtime.recordNativeAuthentication(f.runtime.nativeConnectionConfigGeneration(), true, "owner");
    let rejected = 0; let storageFailure = false;
    f.runtime.subscribeAuthenticationRejected(failed => { rejected++; storageFailure = failed; });
    globalThis.__adapterSecurityFetch = async url => url.endsWith("/api/auth/status")
      ? Response.json({ ok: true, authenticated: false }) : new Response("", { status: 401 });
    await assert.doesNotReject(f.runtime.appFetch("/api/sessions"), "storage failure cannot prevent the rejection notification");
    assert.equal(f.runtime.loadToken(), "");
    assert.equal(f.runtime.loadServerUrl(), "https://old.example.test");
    assert.equal(rejected, 1);
    assert.equal(storageFailure, true);
  } finally { await f.close(); }
});

test("registration migrates legacy storage and leaves failed loads unavailable", async () => {
  const f = await fixture();
  f.window.localStorage.setItem("ac:server-url", "https://old.example.test");
  f.window.localStorage.setItem("ac:token", "old");
  try {
    let saved = { serverUrl: "", token: "" };
    await f.runtime.registerNativeConnectionAdapter({ async load() { return saved; }, async save(value) { saved = value; } });
    assert.deepEqual(saved, { serverUrl: "https://old.example.test", token: "old" });
    assert.equal(f.window.localStorage.getItem("ac:token"), null);
    assert.equal(f.window.localStorage.getItem("ac:server-url"), null);
  } finally {
    await f.close();
  }
});

test("failed registration cannot overwrite host storage through later saves", async () => {
  const f = await fixture();
  let writes = 0;
  try {
    await assert.rejects(f.runtime.registerNativeConnectionAdapter({ async load() { throw Error("unavailable"); }, async save() { writes++; } }));
    await assert.rejects(Promise.resolve().then(() => f.runtime.saveToken("")));
    assert.equal(writes, 0);
  } finally { await f.close(); }
});

test("host platform identifies desktop-class iPad independently of user agent", async () => {
  const f = await fixture();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh)" } });
  try {
    assert.equal(f.runtime.isMacTauri(), true);
    await f.runtime.registerNativeConnectionAdapter({ platform: "ios", async load() { return { serverUrl: "", token: "" }; }, async save() {} });
    assert.equal(f.runtime.isIosTauri(), true);
    assert.equal(f.runtime.isMacTauri(), false);
    assert.equal(f.runtime.isAndroidTauri(), false);
  } finally {
    if (previous) Object.defineProperty(globalThis, "navigator", previous); else Reflect.deleteProperty(globalThis, "navigator");
    await f.close();
  }
});
