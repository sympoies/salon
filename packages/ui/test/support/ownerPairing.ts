import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Plugin } from "vite";
import { createUiSsrHarness } from "./ssr.ts";

export async function verifyOwnerPairingLink(pair: { id: string; code: string; expires_at: number }) {
  const window = new Window({ url: "http://tauri.localhost" });
  const globals = { window, document: window.document, navigator: window.navigator, localStorage: window.localStorage,
    Element: window.Element, HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement,
    Event: window.Event, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const boundary: Plugin = { name: "owner-pairing-fixture", enforce: "pre",
    resolveId(id) {
      if (id.endsWith("deviceSignIn.ts")) return "\0pairing-owner";
      if (id.endsWith("terminalClipboard.ts")) return "\0pairing-clipboard";
    },
    load(id) {
      if (id === "\0pairing-owner") return `export const pairingOrigin=()=>"https://pairing.example.test:9443"; export async function deviceRequest(route){if(route==="devices")return {can_manage:true,devices:[]}; if(route==="pairings")return ${JSON.stringify(pair)}; return {challenge:null};}`;
      if (id === "\0pairing-clipboard") return "export async function writeTerminalClipboardText(text){globalThis.__ownerLink=text}";
    },
  };
  const harness = createUiSsrHarness({ plugins: [boundary] });
  const container = window.document.createElement("div"); window.document.body.append(container);
  const root = createRoot(container as unknown as HTMLElement);
  try {
    const runtime = await harness.loadModule<typeof import("../../src/runtime.ts")>("/src/runtime.ts");
    const { DeviceSettings } = await harness.loadModule<typeof import("../../src/DeviceSettings.tsx")>("/src/DeviceSettings.tsx");
    await act(async () => { root.render(createElement(DeviceSettings, { onSignedOut() {} })); await new Promise(resolve => setTimeout(resolve, 20)); });
    const button = (label: RegExp) => Array.from(container.querySelectorAll("button")).find(b => label.test(b.textContent ?? ""))!;
    await act(async () => { button(/Sign in another device/).click(); await new Promise(resolve => setTimeout(resolve, 20)); });
    assert.equal(container.querySelector(".pairing-code")?.textContent, pair.code);
    await act(async () => { button(/Copy sign-in link/).click(); await new Promise(resolve => setTimeout(resolve, 20)); });
    const ownerLink = (globalThis as typeof globalThis & { __ownerLink: string }).__ownerLink;
    runtime.importPairingLink(ownerLink);
    assert.equal(ownerLink, `https://pairing.example.test:9443/#pair=${pair.code.replaceAll("-", "")}`);
    assert.equal(runtime.pendingPairingLink()?.code, pair.code.replaceAll("-", ""));
  } finally {
    await act(async () => root.unmount()); await harness.close();
    for (const [key, descriptor] of previous) descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
    Reflect.deleteProperty(globalThis, "__ownerLink"); await window.happyDOM.close();
  }
}
