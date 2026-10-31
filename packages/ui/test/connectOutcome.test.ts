import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { SettingsProps } from "../src/Settings.tsx";
import { createUiSsrHarness } from "./support/ssr.ts";

const ssr = createUiSsrHarness();
after(async () => ssr.close());

const authFetch = (response: () => Response | Promise<Response>) => async () => response();
const outcomes = [
  ["rejected", () => new Response(JSON.stringify({ authenticated: false }), { status: 401 })],
  ["rejected", () => new Response(JSON.stringify({ authenticated: false }), { status: 200 })],
  ["unexpected", () => new Response("<html>", { status: 200 })],
  ["unexpected", () => new Response("oops", { status: 502 })],
  ["unreachable", () => { throw new TypeError("network down"); }],
] as const;

for (const [expected, response] of outcomes) {
  test(`getAuthStatus classifies a ${expected} check`, async () => {
    const original = globalThis.fetch;
    globalThis.fetch = authFetch(response) as typeof fetch;
    try {
      const api = await ssr.loadModule<typeof import("../src/api.ts")>("/src/api.ts");
      const status = await api.getAuthStatus();
      assert.equal(status.authenticated, false);
      assert.equal(status.connectFailure, expected);
    } finally {
      globalThis.fetch = original;
    }
  });
}

const messages = {
  rejected: /token was rejected/i,
  unreachable: /server could not be reached/i,
  unexpected: /unexpected response/i,
} as const;

for (const failure of ["rejected", "unreachable", "unexpected"] as const) {
  test(`connect screen shows the ${failure} outcome and is pending during the check`, async () => {
    const window = new Window({ url: "http://localhost" });
    Object.assign(window, { __TAURI_INTERNALS__: {} });
    const previous = {
      window: globalThis.window, document: globalThis.document,
      Element: globalThis.Element, HTMLElement: globalThis.HTMLElement,
      Event: globalThis.Event, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
    };
    Object.assign(globalThis, {
      window, document: window.document, Element: window.Element,
      HTMLElement: window.HTMLElement, Event: window.Event, IS_REACT_ACT_ENVIRONMENT: true,
    });
    const container = window.document.createElement("div");
    window.document.body.append(container);
    const root = createRoot(container);
    const runtime = await ssr.loadModule<typeof import("../src/runtime.ts")>("/src/runtime.ts");
    const { Settings } = await ssr.loadModule<typeof import("../src/Settings.tsx")>("/src/Settings.tsx");
    let finish: (value: typeof failure | undefined) => void = () => {};
    let calls = 0;
    const props: SettingsProps = {
      variant: "connect",
      onSaved() { calls++; return new Promise((resolve) => { finish = resolve; }); },
      machines: [], machineColors: {}, defaultAutoResume: false, attentionAlerts: false,
      terminalRenderMode: "realtime", terminalSelectedPaneRealtime: true,
      onMachineColorChange() {}, onMachineColorReset() {}, onDefaultAutoResumeChange() {},
      onAttentionAlertsChange() {}, onTerminalRenderModeChange() {},
      onTerminalSelectedPaneRealtimeChange() {}, openAccess: true, onSignedOut() {},
    };
    try {
      await act(async () => root.render(createElement(Settings, props)));
      const server = container.querySelector<HTMLInputElement>('input[type="url"]')!;
      const token = container.querySelector<HTMLInputElement>('[data-testid="console-access-token"]')!;
      const button = container.querySelector<HTMLButtonElement>('[data-testid="console-sign-in"]')!;
      const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setValue.call(server, "https://new.example.test:8791");
      setValue.call(token, "fixture-token");
      const submit = () => container.querySelector("form")!
        .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      await act(async () => submit());
      assert.equal(button.disabled, true, "disabled while the check runs");
      assert.match(button.textContent ?? "", /Connecting/);
      await act(async () => submit());
      assert.equal(calls, 1, "a pending check is not submitted twice");
      await act(async () => finish(failure));
      assert.equal(button.disabled, false, "enabled again after a failure");
      assert.equal(button.textContent?.trim(), "Connect");
      const alert = container.querySelector('[role="alert"]');
      assert.match(alert?.textContent ?? "", messages[failure]);
      assert.doesNotMatch(alert?.textContent ?? "", /startup/);
      if (failure === "rejected") {
        assert.equal(runtime.loadToken(), "", "a rejected token is not kept as saved");
        assert.doesNotMatch(container.textContent ?? "", /Access token saved/);
      } else {
        assert.equal(runtime.loadToken(), "fixture-token");
      }
      setValue.call(token, "fixture-token-2");
      await act(async () => submit());
      assert.equal(calls, 2, "the form can be resubmitted");
    } finally {
      await act(async () => root.unmount());
      Object.assign(globalThis, previous);
      await window.happyDOM.close();
    }
  });
}
