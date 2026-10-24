import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Plugin } from "vite";
import { createUiSsrHarness } from "./support/ssr.ts";

declare global {
  var __signOutHttp: typeof fetch | undefined;
}

// Keep App, Settings, the API and device storage real. Replace only the native
// HTTP boundary and the dashboard, whose terminal/polling behavior is unrelated.
const fixture: Plugin = {
  name: "sign-out-boundaries", enforce: "pre",
  resolveId(id, importer) {
    if (!importer?.includes("/src/")) return;
    if (id === "./Dashboard.tsx") return "\0sign-out-dashboard";
    if (id === "./ShellPage.tsx") return "\0sign-out-shell";
    if (id === "@tauri-apps/plugin-http") return "\0sign-out-http";
  },
  load(id) {
    if (id === "\0sign-out-http") return "export const fetch = (...args) => globalThis.__signOutHttp(...args);";
    if (id === "\0sign-out-shell") return "export function ShellPage() { return null; }";
    if (id === "\0sign-out-dashboard") return `
      import React from "react";
      export function Dashboard({onSettings}) {
        return React.createElement("button", {onClick:onSettings,"aria-label":"Open Settings"}, "Settings");
      }
    `;
  },
};

for (const scenario of ["success", "http-failure", "unreachable", "stalled", "browser"] as const) {
  test(scenario === "browser" ? "browser Sign out keeps cookie login behavior and leaves device storage untouched"
    : `${scenario} Sign out clears the native token and stays signed out after App reload`, { timeout: 15_000 }, async (t) => {
    // Each scenario is a fresh document; earlier tests must not spend its boot budget.
    const processNow = performance.now.bind(performance);
    const documentStartedAt = processNow();
    t.mock.method(performance, "now", () => processNow() - documentStartedAt);
    const native = scenario !== "browser";
    const window = new Window({ url: "http://localhost" });
    if (native) Object.assign(window, { __TAURI_INTERNALS__: {} });
    const previous = {
      window: globalThis.window, document: globalThis.document, Element: globalThis.Element,
      HTMLElement: globalThis.HTMLElement, Event: globalThis.Event, MouseEvent: globalThis.MouseEvent,
      KeyboardEvent: globalThis.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
      fetch: globalThis.fetch, __signOutHttp: globalThis.__signOutHttp,
    };
    Object.assign(globalThis, { window, document: window.document, Element: window.Element,
      HTMLElement: window.HTMLElement, Event: window.Event, MouseEvent: window.MouseEvent,
      KeyboardEvent: window.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: true });
    const container = window.document.createElement("div");
    window.document.body.append(container);
    const root = createRoot(container);
    const ssr = createUiSsrHarness({ plugins: [fixture], ssr: { noExternal: ["@tauri-apps/plugin-http"] } });
    const runtime = await ssr.loadModule<typeof import("../src/runtime.ts")>("/src/runtime.ts");
    const storage = await ssr.loadModule<typeof import("../src/storage.ts")>("/src/storage.ts");
    storage.setPrincipalStorageNamespace(null);
    const logoutRequests: { method: string | undefined; authorized: boolean; credentials: RequestCredentials | undefined }[] = [];
    let authRequests = 0;
    let browserSignedOut = false;
    let finishStalledLogout: ((response: Response) => void) | undefined;
    const http: typeof fetch = async (input, init) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (path === "/api/auth/logout") {
        logoutRequests.push({ method: init?.method, authorized: new Headers(init?.headers).has("Authorization"),
          credentials: init?.credentials });
        if (scenario === "unreachable") throw new TypeError("fixture server unreachable");
        if (scenario === "stalled") return new Promise<Response>(resolve => { finishStalledLogout = resolve; });
        if (scenario === "http-failure") return Response.json({ ok: false }, { status: 503 });
        browserSignedOut = true;
        return Response.json({ ok: true });
      }
      if (path === "/api/auth/status") {
        authRequests++;
        // Native bearer authentication is stateless: a saved token still works
        // after /logout, which is the restart bug reported on the S22.
        const authenticated = native
          ? new Headers(init?.headers).has("Authorization") : !browserSignedOut;
        return Response.json({ authenticated, openAccess: false, principal: null });
      }
      if (path === "/api/machines") return Response.json({ machines: [] });
      throw new Error(`unexpected fixture request: ${path}`);
    };
    globalThis.__signOutHttp = http;
    globalThis.fetch = http;
    const waitFor = async (condition: () => boolean) => {
      for (let attempt = 0; attempt < 200; attempt++) {
        if (condition()) return;
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
      }
      assert.fail(`Sign out fixture did not reach the expected screen (auth requests: ${authRequests}, logout requests: ${logoutRequests.length})`);
    };
    try {
      runtime.saveServerUrl("https://console.example.test:8791");
      runtime.saveToken("synthetic-signout-token-1075");
      const { default: App } = await ssr.loadModule<typeof import("../src/App.tsx")>("/src/App.tsx");
      await act(async () => root.render(createElement(App)));
      await waitFor(() => container.querySelector('[aria-label="Open Settings"]') !== null);
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open Settings"]')!.click());
      const signOut = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Sign out");
      assert.ok(signOut);
      await act(async () => signOut.click());
      if (scenario === "stalled") {
        assert.equal(runtime.loadToken() === "", true,
          "native Sign out must remove the saved token before a silent server responds");
      }
      await waitFor(() => container.querySelector('.login [data-testid="console-sign-in"]') !== null
        || (!native && container.querySelector('input[type="password"]') !== null));
      assert.equal(logoutRequests.length, 1, "Sign out still requests server logout");
      assert.equal(logoutRequests[0].method, "POST");
      if (native) {
        assert.equal(logoutRequests[0].authorized, false, "best-effort logout cannot send the deleted bearer");
      } else {
        assert.equal(logoutRequests[0].credentials, "include", "browser logout still uses its cookie");
      }

      // A fresh App instance runs the real startup check against retained device
      // storage, rather than inheriting the current process's signed-out state.
      await act(async () => root.render(null));
      const beforeReloadAuthRequests = authRequests;
      await act(async () => root.render(createElement(App)));
      await waitFor(() => container.querySelector(".boot") === null);
      if (native) {
        assert.equal(container.querySelector('[data-testid="console-sign-in"]')?.textContent?.trim(), "Connect",
          "reload must show Connect instead of authenticating with the retained token");
        assert.equal(runtime.loadToken(), "", "Sign out clears the same device store as Clear saved token");
        assert.equal(authRequests, beforeReloadAuthRequests, "restart needs a new token before contacting the server");
        assert.doesNotMatch(container.textContent ?? "", /Access token saved on this device/);
      } else {
        assert.equal(runtime.loadToken() === "synthetic-signout-token-1075", true, "browser sign-out does not use the device store");
        assert.equal(container.querySelector('input[type="password"]') !== null, true, "browser reload shows login");
      }
      assert.equal(runtime.loadServerUrl(), "https://console.example.test:8791", "keep the server URL");
    } finally {
      await act(async () => {
        finishStalledLogout?.(Response.json({ ok: true }));
        root.unmount();
      });
      storage.setPrincipalStorageNamespace(null);
      await ssr.close();
      Object.assign(globalThis, previous);
      await window.happyDOM.close();
    }
  });
}
