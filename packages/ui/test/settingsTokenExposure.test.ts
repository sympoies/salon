import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { SettingsProps } from "../src/Settings.tsx";
import { createUiSsrHarness } from "./support/ssr.ts";

// Android WebView accessibility reports an input's value, its attributes and its
// text. The stored access token must therefore never reach any of them (#1069).
const ssr = createUiSsrHarness();
after(async () => ssr.close());

const SAVED_TOKEN = "fixture-saved-token-1069";
const ENTERED_TOKEN = "fixture-entered-token-1069";

function exposedStrings(container: Element): string[] {
  const exposed: string[] = [container.textContent ?? ""];
  for (const element of [container, ...container.querySelectorAll("*")]) {
    for (const attribute of Array.from(element.attributes)) exposed.push(attribute.value);
    if (element instanceof globalThis.HTMLInputElement) exposed.push(element.value);
  }
  return exposed;
}

function assertNoToken(container: Element, token: string, when: string): void {
  const leaked = exposedStrings(container).filter((text) => text.includes(token));
  assert.deepEqual(leaked, [], `${when}: the token must not appear in any value, attribute or text`);
}

for (const variant of ["connect", "manage"] as const) {
  test(`native ${variant} never renders the saved token and offers replace and clear`, async () => {
    await withSettings(variant, async ({ container, runtime, saved, rerender }) => {
      runtime.saveServerUrl("https://old.example.test:8791");
      runtime.saveToken(SAVED_TOKEN);
      await rerender();
      const token = tokenField(container);
      assert.equal(token.value, "", "the replace field starts empty");
      assert.match(container.textContent ?? "", /Access token saved/);
      assertNoToken(container, SAVED_TOKEN, "after loading with a saved token");

      // An untouched field keeps the saved token for the same origin, whatever the
      // path: the comparison is on the normalized origin.
      setValue(container.querySelector<HTMLInputElement>('input[type="url"]')!, "https://old.example.test:8791/console/");
      await submit(container, variant);
      assert.equal(saved(), 1);
      assert.equal(runtime.loadToken(), SAVED_TOKEN);
      assert.equal(runtime.loadServerUrl(), "https://old.example.test:8791");

      const clear = Array.from(container.querySelectorAll("button")).find((b) => /Clear saved token/.test(b.textContent ?? ""));
      assert.ok(clear, "an explicit clear action exists");
      await act(async () => clear.click());
      assert.equal(runtime.loadToken(), "");
      assert.doesNotMatch(container.textContent ?? "", /Access token saved/);
    });
  });

  test(`native ${variant} empties the token field once the entered token is saved`, async () => {
    await withSettings(variant, async ({ container, runtime, saved, rerender }) => {
      runtime.saveServerUrl("https://old.example.test:8791");
      await rerender();
      const token = tokenField(container);
      setValue(token, ENTERED_TOKEN);
      await submit(container, variant);
      assert.equal(saved(), 1);
      assert.equal(runtime.loadToken(), ENTERED_TOKEN, "the entered token is still saved");
      assert.equal(token.value, "", "the field is cleared after the save");
      assert.match(container.textContent ?? "", /Access token saved/);
      assertNoToken(container, ENTERED_TOKEN, "after saving an entered token");
    });
  });
}

for (const variant of ["connect", "manage"] as const) {
  test(`native ${variant} refuses an empty token field when the server URL changed (#1072)`, async () => {
    await withSettings(variant, async ({ container, runtime, saved, rerender }) => {
      runtime.saveServerUrl("https://old.example.test:8791");
      runtime.saveToken(SAVED_TOKEN);
      await rerender();
      const requests: string[] = [];
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(`${String(input)} ${JSON.stringify(init ?? {})}`);
        return new Response("{}");
      }) as typeof fetch;
      try {
        setValue(container.querySelector<HTMLInputElement>('input[type="url"]')!, "https://new.example.test:8791");
        await submit(container, variant);
      } finally {
        globalThis.fetch = realFetch;
      }
      assert.equal(saved(), 0, "the connection is not accepted");
      const refusal = Array.from(container.querySelectorAll(".err")).find(
        element => element.textContent === "Enter the access token for this server.");
      assert.equal(refusal?.getAttribute("role"), "alert",
        "the changed-origin refusal must be announced to accessibility");
      assert.equal(runtime.loadToken(), SAVED_TOKEN, "the saved token is unchanged");
      assert.equal(runtime.loadServerUrl(), "https://old.example.test:8791", "the saved URL is unchanged");
      assert.deepEqual(requests.filter((request) => request.includes(SAVED_TOKEN)), [], "no request carries the token");
      assertNoToken(container, SAVED_TOKEN, "after the refused save");

      // Supplying a token for the new server saves both together.
      setValue(tokenField(container), ENTERED_TOKEN);
      await submit(container, variant);
      assert.equal(saved(), 1);
      assert.equal(runtime.loadToken(), ENTERED_TOKEN);
      assert.equal(runtime.loadServerUrl(), "https://new.example.test:8791");
      assert.doesNotMatch(container.textContent ?? "", /Enter the access token for this server/);
    });
  });
}

interface SettingsHarness {
  readonly container: HTMLElement;
  readonly runtime: typeof import("../src/runtime.ts");
  saved(): number;
  rerender(): Promise<void>;
}

async function withSettings(variant: "connect" | "manage", body: (harness: SettingsHarness) => Promise<void>): Promise<void> {
  const window = new Window({ url: "http://localhost" });
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  const previous = {
    window: globalThis.window, document: globalThis.document,
    Element: globalThis.Element, HTMLElement: globalThis.HTMLElement,
    HTMLInputElement: globalThis.HTMLInputElement,
    Event: globalThis.Event, MouseEvent: globalThis.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window, document: window.document, Element: window.Element,
    HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement,
    Event: window.Event, MouseEvent: window.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true,
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
  // Remount so the first render reads the storage the test just prepared.
  const rerender = async () => {
    await act(async () => root.render(null));
    await act(async () => root.render(createElement(Settings, props)));
  };
  try {
    await body({ container, runtime, saved: () => saved, rerender });
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
    await window.happyDOM.close();
  }
}

function tokenField(container: Element): HTMLInputElement {
  const field = container.querySelector<HTMLInputElement>('[data-testid="console-access-token"]');
  assert.ok(field);
  return field;
}

function setValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(globalThis.HTMLInputElement.prototype, "value")!.set!.call(input, value);
}

async function submit(container: Element, variant: "connect" | "manage"): Promise<void> {
  await act(async () => {
    if (variant === "connect") {
      container.querySelector("form")!.dispatchEvent(new globalThis.Event("submit", { bubbles: true, cancelable: true }));
    } else {
      container.querySelector<HTMLButtonElement>('[data-testid="console-sign-in"]')!.click();
    }
  });
}
