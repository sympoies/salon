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
    load(id) { if (id === "\0auth-rejection-transport") return "export const fetch=(url)=>url.endsWith('/api/auth/status') ? Promise.resolve(Response.json({ok:true,authenticated:false})) : globalThis.__authRejectionTransport()"; },
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

test("browser pairing exchange waits for outstanding cookie cleanup", { timeout: 10_000 }, async () => {
  const window = new Window({ url: "https://console.example.test" });
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  globalThis.window = window as unknown as typeof globalThis.window;
  const ssr = createUiSsrHarness();
  let releaseLogout = () => {};
  let exchangeStarted = false;
  let received!: () => void;
  const logoutReceived = new Promise<void>(resolve => { received = resolve; });
  globalThis.fetch = async input => {
    const path = String(input);
    if (path === "/api/auth/status") return Response.json({ ok: true, authenticated: false });
    if (path === "/api/auth/logout") {
      received(); return new Promise(resolve => { releaseLogout = () => resolve(Response.json({ ok: true })); });
    }
    if (path === "/api/auth/pairings/exchange") {
      exchangeStarted = true; return Response.json({ data: { principal: "owner", id: "replacement" } });
    }
    return new Response("", { status: 401 });
  };
  try {
    const runtime = await ssr.loadModule<typeof import("../src/runtime.ts")>("/src/runtime.ts");
    const pairing = await ssr.loadModule<typeof import("../src/deviceSignIn.ts")>("/src/deviceSignIn.ts");
    runtime.recordNativeAuthentication(runtime.nativeConnectionConfigGeneration(), true, "owner");
    await runtime.appFetch("/api/machines");
    await logoutReceived;
    const exchange = pairing.deviceRequest<{ principal: string }>("pairings/exchange", { confirmed: true });
    assert.equal(exchangeStarted, false, "pairing cannot install a cookie before old logout completes");
    releaseLogout();
    assert.equal((await exchange).principal, "owner");
    assert.equal(exchangeStarted, true);
  } finally {
    releaseLogout(); globalThis.fetch = previousFetch; globalThis.window = previousWindow;
    await ssr.close(); await window.happyDOM.close();
  }
});

test("an unavailable edge auth confirmation keeps the signed-in connection", async () => {
  const window = new Window({ url: "https://console.example.test" });
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  globalThis.window = window as unknown as typeof globalThis.window;
  const ssr = createUiSsrHarness();
  let logoutRequests = 0;
  globalThis.fetch = async input => {
    if (String(input) === "/api/auth/status") throw new TypeError("Synthetic confirmation outage");
    if (String(input) === "/api/auth/logout") logoutRequests++;
    return new Response("", { status: 401 });
  };
  let unsubscribe = () => {};
  try {
    const runtime = await ssr.loadModule<typeof import("../src/runtime.ts")>("/src/runtime.ts");
    runtime.recordNativeAuthentication(runtime.nativeConnectionConfigGeneration(), true, "owner");
    let rejected = 0;
    unsubscribe = runtime.subscribeAuthenticationRejected(() => { rejected++; });
    assert.equal((await runtime.appFetch("/api/machines")).status, 401);
    assert.equal(rejected, 0, "unconfirmed operation failure cannot end edge authentication");
    assert.equal(logoutRequests, 0);
  } finally {
    unsubscribe(); globalThis.fetch = previousFetch; globalThis.window = previousWindow;
    await ssr.close(); await window.happyDOM.close();
  }
});
