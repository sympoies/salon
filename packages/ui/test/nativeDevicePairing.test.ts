import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Plugin } from "vite";
import { createUiSsrHarness } from "./support/ssr.ts";

declare global {
  var __nativePairingFetch: ((url: string, init: RequestInit & { maxRedirections?: number }) => Promise<Response>) | undefined;
}

for (const interruption of ["none", "connection", "cancel", "storage-failure"]) test(`native pairing requires local consent and preserves connection identity (${interruption})`, async () => {
  const window = new Window({ url: "http://tauri.localhost" });
  const globals = { window, document: window.document, navigator: window.navigator, localStorage: window.localStorage,
    Element: window.Element, HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement, Event: window.Event, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const boundary: Plugin = { name: "native-pairing-http", enforce: "pre",
    resolveId(id) { if (id === "@tauri-apps/plugin-http") return "\0native-pairing-http"; },
    load(id) { if (id === "\0native-pairing-http") return "export const fetch=(url,init)=>globalThis.__nativePairingFetch(url,init);"; },
  };
  const harness = createUiSsrHarness({ plugins: [boundary], ssr: { noExternal: ["@tauri-apps/plugin-http"] } });
  const container = window.document.createElement("div"); window.document.body.append(container);
  const root = createRoot(container);
  const calls: { url: string; init: RequestInit & { maxRedirections?: number } }[] = [];
  let installed = 0;
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const exchangeStarted = new Promise<void>(resolve => { entered = resolve; });
  const credential = `salon_device_${"X".repeat(43)}`;
  globalThis.__nativePairingFetch = async (url, init) => {
    if (!url.includes("/api/auth/pairings/")) return Response.json({ ok: true, data: { version: "0.0.0" } });
    calls.push({ url, init });
    const body = JSON.parse(String(init.body ?? "{}"));
    if (url.endsWith("/claim")) return Response.json({ ok: true, data: { id: "pairing-fixture", principal: "example-principal",
      challenge: body.challenge, origin: "https://console.example.test", delivery: "native", verification: "ABCDEFGH", expires_at: Date.now() + 300_000 } });
    entered(); await pending;
    return Response.json({ ok: true, data: { id: "device-fixture", principal: "example-principal", credential, expires_at: Date.now() + 86_400_000 } });
  };
  try {
    const runtime = await harness.loadModule<typeof import("../src/runtime.ts")>("/src/runtime.ts");
    runtime.saveServerUrl("https://previous.example.test"); runtime.saveToken("previous-synthetic-token");
    let failStorage = interruption === "storage-failure";
    if (failStorage) await runtime.registerNativeConnectionAdapter({
      async load() { return { serverUrl: "https://previous.example.test", token: "previous-synthetic-token" }; },
      async save() { if (failStorage) throw Error("storage unavailable"); },
    });
    const { Settings } = await harness.loadModule<typeof import("../src/Settings.tsx")>("/src/Settings.tsx");
    await act(async () => root.render(createElement(Settings, { variant: "connect", onSaved() { installed++; },
      machines: [], machineColors: {}, terminalRenderMode: "realtime", terminalSelectedPaneRealtime: true,
      onMachineColorChange() {}, onMachineColorReset() {}, onDefaultAutoResumeChange() {}, onAttentionAlertsChange() {},
      onTerminalRenderModeChange() {}, onTerminalSelectedPaneRealtimeChange() {}, openAccess: false, onSignedOut() {},
    })));
    const entry = Array.from(container.querySelectorAll("button")).find(button => /Use a pairing code/.test(button.textContent ?? ""));
    assert.ok(entry, "native connection settings expose the pairing recipient flow");
    await act(async () => entry.click());
    const server = container.querySelector<HTMLInputElement>('[aria-label="Server URL"]');
    assert.ok(server, "native recipient exposes a server URL without requiring the main token");
    server.value = "https://console.example.test";
    container.querySelector<HTMLInputElement>('[aria-label="Pairing code"]')!.value = "ABCD-EFGH-JKLM-NPQR-STUV";
    await act(async () => { container.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); await new Promise(resolve => setTimeout(resolve, 30)); });
    assert.match(container.textContent ?? "", /example-principal/);
    assert.equal(calls.length, 1, "claim must not automatically exchange or install credentials");
    assert.equal(runtime.loadServerUrl(), "https://previous.example.test");
    assert.equal(runtime.loadToken(), "previous-synthetic-token");
    const consent = Array.from(container.querySelectorAll("button")).find(button => /Sign in as example-principal/.test(button.textContent ?? ""));
    await act(async () => { consent!.click(); await exchangeStarted; });
    if (interruption === "connection") runtime.saveServerUrl("https://changed.example.test");
    if (interruption === "cancel") await act(async () => Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Cancel")!.click());
    await act(async () => { release(); await new Promise(resolve => setTimeout(resolve, 30)); });
    if (interruption === "storage-failure") {
      assert.match(container.textContent ?? "", /device was added but not stored/i);
      const retry = Array.from(container.querySelectorAll("button")).find(button => /retry saving/i.test(button.textContent ?? ""));
      assert.ok(retry, "the issued credential can be saved again without a new exchange");
      failStorage = false;
      await act(async () => { retry.click(); await new Promise(resolve => setTimeout(resolve, 30)); });
      assert.equal(calls.length, 2, "retry must not exchange again");
    }
    assert.equal(installed, interruption === "none" || interruption === "storage-failure" ? 1 : 0);
    assert.equal(runtime.loadToken(), interruption === "none" || interruption === "storage-failure" ? credential : "previous-synthetic-token");
    assert.equal(runtime.loadServerUrl(), interruption === "connection" ? "https://changed.example.test"
      : interruption === "cancel" ? "https://previous.example.test" : "https://console.example.test");
    for (const call of calls) {
      assert.equal(new URL(call.url).origin, "https://console.example.test");
      assert.equal(call.init.maxRedirections, 0);
      assert.equal(call.init.credentials, "omit");
      const headers = new Headers(call.init.headers);
      for (const name of ["authorization", "cookie", "origin"]) assert.equal(headers.has(name), false);
      assert.equal(JSON.parse(String(call.init.body)).delivery, "native");
    }
    assert.equal(container.innerHTML.includes(credential), false);
    assert.equal(JSON.stringify(window.localStorage).includes("ABCD-EFGH-JKLM-NPQR-STUV"), false);
  } finally {
    release(); await act(async () => root.unmount()); await harness.close();
    for (const [key, descriptor] of previous) descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
    delete globalThis.__nativePairingFetch; await window.happyDOM.close();
  }
});

test("native pairing refuses HTTP and redirects, uses only intended credentials and sanitizes transport errors", async () => {
  const window = new Window({ url: "http://tauri.localhost" });
  const globals = { window, localStorage: window.localStorage };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const boundary: Plugin = { name: "native-pairing-boundary", enforce: "pre",
    resolveId(id) { if (id === "@tauri-apps/plugin-http") return "\0native-pairing-boundary"; },
    load(id) { if (id === "\0native-pairing-boundary") return "export const fetch=(url,init)=>globalThis.__nativePairingFetch(url,init);"; },
  };
  const harness = createUiSsrHarness({ plugins: [boundary], ssr: { noExternal: ["@tauri-apps/plugin-http"] } });
  const calls: RequestInit[] = [];
  let mode = "redirect";
  const secret = "synthetic-pairing-secret-sentinel";
  globalThis.__nativePairingFetch = async (_url, init) => {
    calls.push(init); assert.equal(init.maxRedirections, 0);
    if (mode === "error") throw new Error(secret);
    if (mode === "redirect") return new Response(secret, { status: 302, headers: { location: "http://insecure.example.test/" } });
    return Response.json({ ok: true, data: { devices: [] } });
  };
  try {
    const runtime = await harness.loadModule<typeof import("../src/runtime.ts")>("/src/runtime.ts");
    const pairing = await harness.loadModule<typeof import("../src/deviceSignIn.ts")>("/src/deviceSignIn.ts");
    runtime.saveServerUrl("http://localhost"); runtime.saveToken("main-synthetic-token");
    await assert.rejects(pairing.deviceRequest("pairings", {}), (error: Error) => error.message === "Device sign-in unavailable. Please try again.");
    assert.equal(calls.length, 0, "even loopback HTTP cannot receive native pairing secrets");
    runtime.saveServerUrl("https://console.example.test");
    const connection = pairing.pairingConnection();
    await assert.rejects(pairing.deviceRequest("pairings/claim", { code: secret }, "POST", undefined, connection),
      (error: Error) => error.message === "Device sign-in unavailable. Please try again.");
    assert.equal(calls.length, 1, "a redirect never triggers another transport call");
    assert.equal(new Headers(calls[0]!.headers).has("authorization"), false);
    mode = "error";
    await assert.rejects(pairing.deviceRequest("pairings/claim", { code: secret }, "POST", undefined, connection),
      (error: Error) => !String(error).includes(secret));
    mode = "success";
    await pairing.deviceRequest("devices");
    assert.equal(new Headers(calls.at(-1)!.headers).get("authorization"), "Bearer main-synthetic-token", "management retains the existing explicit token path");
  } finally {
    await harness.close(); for (const [key, descriptor] of previous) descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
    delete globalThis.__nativePairingFetch; await window.happyDOM.close();
  }
});
