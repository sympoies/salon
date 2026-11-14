import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { createUiSsrHarness } from "./support/ssr.ts";

const ssr = createUiSsrHarness();
after(async () => ssr.close());

test("recipient sees the target account and must explicitly consent; cancel and a new claim do not reuse consent", async () => {
  const window = new Window({ url: "https://console.example.test" });
  const previous = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch,
    HTMLElement: globalThis.HTMLElement, HTMLInputElement: globalThis.HTMLInputElement,
    Event: globalThis.Event, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement, Event: window.Event, IS_REACT_ACT_ENVIRONMENT: true });
  const calls: string[] = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(url));
    const body = JSON.parse(String(init?.body ?? "{}"));
    const data = String(url).endsWith("/claim")
      ? { id: "claim-fixture", principal: "example-principal", challenge: body.challenge,
        origin: "https://console.example.test", delivery: "browser", verification: "ABCDEFGH", expires_at: Date.now() + 300_000 }
      : { id: "device-fixture", principal: "example-principal", expires_at: Date.now() + 30 * 86_400_000 };
    return new Response(JSON.stringify({ ok: true, data }), { status: 200 });
  }) as typeof fetch;
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  let signedIn = 0;
  const button = (text: RegExp) => Array.from(container.querySelectorAll("button")).find(b => text.test(b.textContent ?? ""));
  const { Login } = await ssr.loadModule<typeof import("../src/Login.tsx")>("/src/Login.tsx");
  const claim = async () => {
    const entry = button(/Use a pairing code/);
    assert.equal(Boolean(entry), true, "browser sign-in exposes manual pairing entry");
    await act(async () => entry!.click());
    const input = container.querySelector<HTMLInputElement>('[aria-label="Pairing code"]');
    assert.equal(Boolean(input), true);
    input!.value = "ABCD-EFGH-JKLM-NPQR-STUV";
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      await new Promise(resolve => setTimeout(resolve, 20));
    });
  };
  try {
    await act(async () => root.render(createElement(Login, { onSignedIn() { signedIn++; } })));
    await claim();
    assert.match(container.textContent ?? "", /example-principal/);
    assert.match(container.textContent ?? "", /https:\/\/console\.example\.test/);
    assert.equal(calls.filter(path => path.endsWith("/exchange")).length, 0, "even an approved remote link cannot install before consent");
    await act(async () => button(/^Cancel$/)!.click());
    assert.equal(calls.filter(path => path.endsWith("/exchange")).length, 0);
    assert.equal(signedIn, 0);
    await claim();
    assert.equal(calls.filter(path => path.endsWith("/exchange")).length, 0, "new pairing has no previous consent");
    await act(async () => { button(/Sign in as example-principal/)!.click(); await new Promise(resolve => setTimeout(resolve, 20)); });
    assert.equal(calls.filter(path => path.endsWith("/exchange")).length, 1);
    assert.equal(signedIn, 1);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
    await window.happyDOM.close();
  }
});
