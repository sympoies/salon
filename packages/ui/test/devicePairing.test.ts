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

for (const mismatch of ["claim delivery", "claim origin", "issued principal"]) test(`recipient rejects a mismatched ${mismatch}`, async () => {
  const window = new Window({ url: "https://console.example.test" });
  const previous = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch,
    HTMLElement: globalThis.HTMLElement, HTMLInputElement: globalThis.HTMLInputElement,
    Event: globalThis.Event, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement, Event: window.Event, IS_REACT_ACT_ENVIRONMENT: true });
  let exchanges = 0;
  let signedIn = 0;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (String(url).endsWith("/claim")) return Response.json({ ok: true, data: {
      id: "claim-fixture", principal: "example-principal", challenge: body.challenge,
      origin: mismatch === "claim origin" ? "https://other.example.test" : "https://console.example.test",
      delivery: mismatch === "claim delivery" ? "native" : "browser", verification: "ABCDEFGH",
      expires_at: Date.now() + 300_000,
    } });
    exchanges++;
    return Response.json({ ok: true, data: { id: "device-fixture", principal: "other-principal", expires_at: Date.now() + 86_400_000 } });
  }) as typeof fetch;
  const container = window.document.createElement("div"); window.document.body.append(container);
  const root = createRoot(container);
  const { PairingRecipient } = await ssr.loadModule<typeof import("../src/PairingRecipient.tsx")>("/src/PairingRecipient.tsx");
  try {
    await act(async () => root.render(createElement(PairingRecipient, { onSignedIn() { signedIn++; }, onCancel() {} })));
    container.querySelector<HTMLInputElement>('[aria-label="Pairing code"]')!.value = "ABCD-EFGH-JKLM-NPQR-STUV";
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    const consent = Array.from(container.querySelectorAll("button")).find(button => /Sign in as/.test(button.textContent ?? ""));
    if (mismatch === "issued principal") {
      assert.ok(consent, "a consistent claim reaches local account consent");
      await act(async () => { consent.click(); await new Promise(resolve => setTimeout(resolve, 20)); });
      assert.equal(exchanges, 1, "the inconsistent account is returned by the exchange");
      assert.match(container.textContent ?? "", /Waiting for approval/);
    } else {
      assert.equal(Boolean(consent), false, "an inconsistent claim cannot be presented for consent");
      assert.match(container.querySelector('[role="alert"]')?.textContent ?? "", /Pairing unavailable/);
      assert.equal(exchanges, 0, "an inconsistent claim never reaches exchange");
    }
    assert.equal(signedIn, 0, "an inconsistent account or delivery cannot complete sign-in");
  } finally {
    await act(async () => root.unmount()); Object.assign(globalThis, previous); await window.happyDOM.close();
  }
});

test("browser device requests reject a response from a different origin", async () => {
  const window = new Window({ url: "https://console.example.test" });
  const previous = { window: globalThis.window, fetch: globalThis.fetch };
  Object.assign(globalThis, { window });
  const { deviceRequest } = await ssr.loadModule<typeof import("../src/deviceSignIn.ts")>("/src/deviceSignIn.ts");
  const data = { id: "claim-fixture", principal: "example-principal" };
  let origin = "https://other.example.test";
  globalThis.fetch = (async () => {
    const response = Response.json({ ok: true, data });
    Object.defineProperty(response, "url", { value: `${origin}/api/auth/pairings/claim` });
    return response;
  }) as typeof fetch;
  try {
    await assert.rejects(deviceRequest("pairings/claim", { code: "synthetic-code" }),
      (error: Error) => error.message === "Device sign-in unavailable. Please try again.");
    origin = window.location.origin;
    assert.deepEqual(await deviceRequest("pairings/claim", { code: "synthetic-code" }), data,
      "a response from the intended origin remains usable");
  } finally { Object.assign(globalThis, previous); await window.happyDOM.close(); }
});
