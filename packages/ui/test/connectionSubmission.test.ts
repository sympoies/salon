import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { SettingsProps } from "../src/Settings.tsx";
import { createUiSsrHarness } from "./support/ssr.ts";

const ssr = createUiSsrHarness();
after(async () => ssr.close());

for (const variant of ["connect", "manage"] as const) {
  for (const scenario of ["fill", "replace", "clear", "invalid-server"] as const) {
    test(`native ${variant} reads the current controls after external ${scenario}`, async () => {
      const window = new Window({ url: "http://localhost" });
      Object.assign(window, { __TAURI_INTERNALS__: {} });
      const previous = {
        window: globalThis.window, document: globalThis.document,
        Element: globalThis.Element, HTMLElement: globalThis.HTMLElement,
        Event: globalThis.Event, MouseEvent: globalThis.MouseEvent,
        IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
      };
      Object.assign(globalThis, {
        window, document: window.document, Element: window.Element,
        HTMLElement: window.HTMLElement, Event: window.Event,
        MouseEvent: window.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true,
      });
      const container = window.document.createElement("div");
      window.document.body.append(container);
      const root = createRoot(container);
      const runtime = await ssr.loadModule<typeof import("../src/runtime.ts")>("/src/runtime.ts");
      const { Settings } = await ssr.loadModule<typeof import("../src/Settings.tsx")>("/src/Settings.tsx");
      let saved = 0;
      const props: SettingsProps = {
        variant, onSaved() { saved++; }, machines: [], machineColors: {},
        defaultAutoResume: false, attentionAlerts: false, pinCoordinators: false,
        terminalRenderMode: "realtime", terminalSelectedPaneRealtime: true,
        onMachineColorChange() {}, onMachineColorReset() {}, onDefaultAutoResumeChange() {},
        onAttentionAlertsChange() {}, onPinCoordinatorsChange() {},
        onTerminalRenderModeChange() {}, onTerminalSelectedPaneRealtimeChange() {},
        openAccess: true, onSignedOut() {},
      };
      try {
        runtime.saveServerUrl("https://old.example.test:8791");
        if (scenario !== "fill") {
          runtime.saveToken("fixture-old-token");
        }
        await act(async () => root.render(createElement(Settings, props)));
        const server = container.querySelector<HTMLInputElement>('input[type="url"]');
        const token = container.querySelector<HTMLInputElement>('[data-testid="console-access-token"]');
        const button = container.querySelector<HTMLButtonElement>('[data-testid="console-sign-in"]');
        assert.ok(server && token && button);
        // Accessibility/autofill can change a native control without a React
        // input/change event. Exercise the actual form with synthetic data only.
        const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
        setValue.call(server, scenario === "invalid-server" ? "http://[" : "https://new.example.test:8791/path");
        setValue.call(token, scenario === "clear" ? "   " : "fixture-new-token");
        // An unrelated parent render must not overwrite an external fill.
        await act(async () => root.render(createElement(Settings, { ...props, pinCoordinators: true })));
        await act(async () => {
          if (variant === "connect") {
            container.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
          } else {
            button.click();
          }
        });
        if (scenario === "clear" || scenario === "invalid-server") {
          assert.equal(saved, 0, "invalid current controls must not resubmit stale saved credentials");
          assert.match(container.textContent ?? "", scenario === "clear" ? /Enter the console access token/ : /Enter a valid server URL/);
          assert.equal(runtime.loadServerUrl(), "https://old.example.test:8791");
          assert.equal(runtime.loadToken(), "fixture-old-token");
        } else {
          assert.equal(saved, 1, "external fill must reach the connection recheck");
          assert.equal(runtime.loadServerUrl(), "https://new.example.test:8791");
          assert.equal(runtime.loadToken(), "fixture-new-token", "use the current control, including external credential replacement");
        }
      } finally {
        await act(async () => root.unmount());
        Object.assign(globalThis, previous);
        await window.happyDOM.close();
      }
    });
  }
}
