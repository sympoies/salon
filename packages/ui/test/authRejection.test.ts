import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Window } from "happy-dom";
import { createUiSsrHarness } from "./support/ssr.ts";

declare global { var __authRejectionTransport: () => Promise<Response>; }

test("native refusals retain a replacement connection and permission denials retain its credential", { timeout: 10_000 }, async () => {
  const window = new Window({ url: "http://localhost" });
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  const previous = globalThis.window;
  globalThis.window = window as unknown as typeof globalThis.window;
  const ssr = createUiSsrHarness({ ssr: { noExternal: ["@tauri-apps/plugin-http"] }, plugins: [{
    name: "auth-rejection-transport", enforce: "pre",
    resolveId(id) { if (id === "@tauri-apps/plugin-http") return "\0auth-rejection-transport"; },
    load(id) { if (id === "\0auth-rejection-transport") return "export const fetch=()=>globalThis.__authRejectionTransport()"; },
  }] });
  let unsubscribe = () => {};
  try {
    const runtime = await ssr.loadModule<typeof import("../src/runtime.ts")>("/src/runtime.ts");
    runtime.saveServerUrl("https://console.example.test");
    runtime.saveToken("old-fixture");
    runtime.recordNativeAuthentication(runtime.nativeConnectionConfigGeneration(), true, "owner");
    let rejected = 0;
    unsubscribe = runtime.subscribeAuthenticationRejected(() => { rejected++; });
    let respond!: (response: Response) => void;
    let started!: () => void;
    const inFlight = new Promise<void>(resolve => { started = resolve; });
    globalThis.__authRejectionTransport = () => { started(); return new Promise(resolve => { respond = resolve; }); };
    const oldRequest = runtime.appFetch("/api/sessions");
    await inFlight;
    runtime.saveToken("replacement-fixture");
    runtime.recordNativeAuthentication(runtime.nativeConnectionConfigGeneration(), true, "owner");
    respond(new Response("", { status: 401 }));
    await oldRequest;
    assert.equal(runtime.loadToken(), "replacement-fixture", "old 401 cannot clear a replacement credential");
    assert.equal(rejected, 0);
    globalThis.__authRejectionTransport = async () => new Response("", { status: 403 });
    await runtime.appFetch("/api/sessions");
    assert.equal(runtime.loadToken(), "replacement-fixture", "403 is a permission refusal");
    assert.equal(rejected, 0);
    globalThis.__authRejectionTransport = async () => new Response("", { status: 401 });
    await runtime.appFetch("/api/sessions");
    assert.equal(runtime.loadToken(), "");
    assert.equal(runtime.loadServerUrl(), "https://console.example.test");
    assert.equal(rejected, 1, "active 401 signs out exactly once");
  } finally {
    unsubscribe();
    globalThis.window = previous;
    await ssr.close();
    await window.happyDOM.close();
  }
});
