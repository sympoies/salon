import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { Plugin } from "vite";
import { createUiSsrHarness } from "./support/ssr.ts";

const code = "ABCDEFGHJKLMNPQRSTUV";
const link = `https://pairing.example.test:9443/#pair=${code}`;
type Runtime = typeof import("../src/runtime.ts") & { importPairingLink(url: string): void };

async function fixture() {
  const window = new Window({ url: "http://tauri.localhost" });
  const globals = { window, document: window.document, navigator: window.navigator, localStorage: window.localStorage,
    Element: window.Element, HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement,
    Event: window.Event, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const calls: { url: string; init: RequestInit & { maxRedirections?: number } }[] = [];
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const exchanged = new Promise<void>(resolve => { entered = resolve; });
  const credential = `salon_device_${"X".repeat(43)}`;
  const transport = async (url: string, init: RequestInit & { maxRedirections?: number }) => {
    if (!url.includes("/pairings/")) return Response.json({ authenticated: false, openAccess: false });
    calls.push({ url, init });
    const body = JSON.parse(String(init.body));
    if (url.endsWith("/claim")) return Response.json({ data: { id: "pairing-fixture", principal: "example-principal",
      challenge: body.challenge, origin: new URL(url).origin, delivery: "native", verification: "ABCDEFGH", expires_at: Date.now() + 300_000 } });
    entered(); await pending;
    return Response.json({ data: { id: "device-fixture", principal: "example-principal", credential, expires_at: Date.now() + 86_400_000 } });
  };
  Object.assign(globalThis, { __pairingLinkFetch: transport });
  const boundary: Plugin = { name: "pairing-link-transport", enforce: "pre",
    resolveId(id) {
      if (id === "@tauri-apps/plugin-http") return "\0pairing-link-http";
      if (id.endsWith("TerminalPane.tsx")) return "\0pairing-link-terminal";
    },
    load(id) {
      if (id === "\0pairing-link-http") return "export const fetch=(url,init)=>globalThis.__pairingLinkFetch(url,init);";
      if (id === "\0pairing-link-terminal") return "export function TerminalPane(){return null}";
    },
  };
  const harness = createUiSsrHarness({ plugins: [boundary], ssr: { noExternal: ["@tauri-apps/plugin-http"] } });
  const container = window.document.createElement("div"); window.document.body.append(container);
  const root = createRoot(container);
  const runtime = await harness.loadModule<Runtime>("/src/runtime.ts");
  runtime.saveServerUrl("https://previous.example.test"); runtime.saveToken("previous-synthetic-token");
  return { window, harness, container, root, runtime, calls, credential, release, exchanged,
    async close() {
      release(); await act(async () => root.unmount()); await harness.close();
      for (const [key, descriptor] of previous) descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
      Reflect.deleteProperty(globalThis, "__pairingLinkFetch"); await window.happyDOM.close();
    } };
}

test("native pairing imports reject malformed and non-fragment links with a fixed secret-free error", async () => {
  const f = await fixture();
  try {
    assert.equal(typeof f.runtime.importPairingLink, "function", "shells need a callable pairing-link import entry");
    for (const invalid of ["not-a-url", link.replace("https:", "http:"), link.replace("https:", "tauri:"),
      link.replace("/#", "/?"), link.replace("/#", "/?extra=1#"), link + "&extra=1",
      link.replace("/#", "/path#"), link.replace("/#", "/path/..#"), link.replace("//", "//user:password@"),
      link.replace(code, "I".repeat(20)), link.replace(code, "A".repeat(81)), `${link}${"x".repeat(2048)}`,
      `https://${"a".repeat(2048)}.example.test/#pair=${code}`,
      ` ${link}`, link.replace("https://", "https:\\"), `${link}\n`]) {
      assert.throws(() => f.runtime.importPairingLink(invalid), { message: "Invalid pairing link." });
    }
    assert.equal(f.calls.length, 0);
    assert.equal(f.runtime.loadServerUrl(), "https://previous.example.test");
    assert.equal(f.runtime.loadToken(), "previous-synthetic-token");
  } finally { await f.close(); }
});

for (const interruption of ["none", "cancel", "connection", "replacement"]) test(`imported link reaches consent and fences credential installation (${interruption})`, async () => {
  const f = await fixture();
  try {
    assert.equal(typeof f.runtime.importPairingLink, "function", "shells need a callable pairing-link import entry");
    f.runtime.importPairingLink(link);
    const { default: App } = await f.harness.loadModule<typeof import("../src/App.tsx")>("/src/App.tsx");
    await act(async () => f.root.render(createElement(StrictMode, null, createElement(App))));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    assert.match(f.container.textContent ?? "", /https:\/\/pairing\.example\.test:9443/);
    assert.match(f.container.textContent ?? "", /example-principal/);
    assert.equal(f.calls.length, 1, "claim cannot install or exchange without recipient consent");
    assert.equal(Boolean(f.container.querySelector('[aria-label="Pairing code"]')), false, "link import needs no code typing");
    assert.equal(f.runtime.loadToken(), "previous-synthetic-token");
    assert.equal(f.runtime.loadServerUrl(), "https://previous.example.test");
    const button = (label: RegExp) => Array.from(f.container.querySelectorAll("button")).find(b => label.test(b.textContent ?? ""))!;
    await act(async () => { button(/Sign in as example-principal/).click(); await f.exchanged; });
    if (interruption === "cancel") await act(async () => button(/^Cancel$/).click());
    if (interruption === "connection") await act(async () => f.runtime.saveServerUrl("https://changed.example.test"));
    if (interruption === "replacement") await act(async () => { f.runtime.importPairingLink(link.replace(code, "A".repeat(20))); await new Promise(resolve => setTimeout(resolve, 30)); });
    await act(async () => { f.release(); await new Promise(resolve => setTimeout(resolve, 30)); });
    assert.equal(f.runtime.loadToken(), interruption === "none" ? f.credential : "previous-synthetic-token");
    assert.equal(f.runtime.loadServerUrl(), interruption === "none" ? "https://pairing.example.test:9443"
      : interruption === "connection" ? "https://changed.example.test" : "https://previous.example.test");
    if (interruption === "replacement") assert.ok(button(/Sign in as example-principal/), "replacement requires fresh consent");
    for (const call of f.calls) {
      assert.equal(new URL(call.url).origin, "https://pairing.example.test:9443");
      assert.equal(call.init.credentials, "omit"); assert.equal(call.init.maxRedirections, 0);
      assert.equal(call.init.redirect, "error");
      for (const header of ["authorization", "cookie", "origin"]) assert.equal(new Headers(call.init.headers).has(header), false);
      assert.equal(JSON.parse(String(call.init.body)).delivery, "native");
    }
    assert.equal(f.container.innerHTML.includes(f.credential), false);
    assert.equal(JSON.stringify(f.window.localStorage).includes(code), false);
  } finally { await f.close(); }
});

for (const outcome of ["valid", "cancel", "error", "connection"]) test(`consumer Scan QR hook imports only a current successful scan (${outcome})`, async () => {
  const f = await fixture();
  try {
    const { PairingLinkContext, ScanPairingLinkButton } = await f.harness.loadModule<typeof import("../src/PairingLinkActions.tsx")>("/src/PairingLinkActions.tsx");
    let resolve!: (value: string | null) => void;
    let reject!: (reason: Error) => void;
    const scanned = new Promise<string | null>((yes, no) => { resolve = yes; reject = no; });
    await act(async () => f.root.render(createElement(PairingLinkContext.Provider, { value: { scanPairingLink: () => scanned } }, createElement(ScanPairingLinkButton))));
    await act(async () => f.container.querySelector("button")!.click());
    if (outcome === "connection") f.runtime.saveToken("replacement-synthetic-token");
    await act(async () => {
      if (outcome === "error") reject(new Error(link));
      else resolve(outcome === "cancel" ? null : link);
    });
    assert.equal(Boolean(f.runtime.pendingPairingLink()), outcome === "valid");
    assert.equal(f.calls.length, 0, "scanning hands off input without performing claim or exchange itself");
    assert.equal((f.container.textContent ?? "").includes(code), false);
    if (outcome === "error") assert.equal(f.container.querySelector('[role="alert"]')?.textContent, "QR scan unavailable. Please try again.");
  } finally { await f.close(); }
});

test("browser Open in app hook receives the scrubbed fragment only on an explicit action before claim", async () => {
  const f = await fixture();
  try {
    f.window.location.href = `https://pairing.example.test/#pair=${code}`;
    const { capturePairingLanding } = await f.harness.loadModule<typeof import("../src/pairingLanding.ts")>("/src/pairingLanding.ts");
    capturePairingLanding(f.window as unknown as Window);
    const { PairingLinkContext } = await f.harness.loadModule<typeof import("../src/PairingLinkActions.tsx")>("/src/PairingLinkActions.tsx");
    const { PairingRecipient } = await f.harness.loadModule<typeof import("../src/PairingRecipient.tsx")>("/src/PairingRecipient.tsx");
    const received: string[] = [];
    await act(async () => f.root.render(createElement(PairingLinkContext.Provider, { value: {
      openPairingLinkInApp(url: string) { received.push(url); throw new Error(url); },
    } }, createElement(PairingRecipient, { onCancel() {}, onSignedIn() {} }))));
    assert.equal(f.window.location.hash, ""); assert.equal(received.length, 0);
    assert.throws(() => f.runtime.importPairingLink(link), { message: "Pairing link import requires a native shell." });
    await act(async () => Array.from(f.container.querySelectorAll("button")).find(button => button.textContent === "Open in app")!.click());
    assert.deepEqual(received, [`https://pairing.example.test/#pair=${code}`]);
    assert.equal(f.calls.length, 0); assert.equal(f.runtime.loadToken(), "previous-synthetic-token");
    assert.equal(f.container.querySelector('[role="alert"]')?.textContent, "App handoff unavailable. Please try again.");
  } finally { await f.close(); }
});
