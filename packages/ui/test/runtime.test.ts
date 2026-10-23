import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  apiBase,
  applyAndroidSafeAreaInsets,
  isAndroidTauri,
  isMacTauri,
  isTauri,
  needsDeviceConfig,
  normalizeServerUrl,
  wsProtocols,
  wsUrl,
} from "../src/runtime.ts";

test("normalizeServerUrl adds https, strips path/query/trailing slash", () => {
  assert.equal(normalizeServerUrl("console.example.com:8791"), "https://console.example.com:8791");
  assert.equal(normalizeServerUrl("https://host:8791/foo?x=1#h"), "https://host:8791");
  assert.equal(normalizeServerUrl("http://host:8790/"), "http://host:8790");
  assert.equal(normalizeServerUrl(""), "");
  assert.equal(normalizeServerUrl("   "), "");
});

test("outside a Tauri runtime (browser/node) the shim is same-origin, no token subprotocol", () => {
  // No window in node -> not Tauri -> same-origin ("") + cookie auth (undefined protocols).
  assert.equal(isTauri(), false);
  assert.equal(apiBase(), "");
  assert.equal(wsProtocols(), undefined);
});

test("device (Tauri) branch: configured server + token drive cross-origin + subprotocol auth", () => {
  const origWin = (globalThis as { window?: unknown }).window;
  const origLS = (globalThis as { localStorage?: unknown }).localStorage;
  const store = new Map<string, string>();
  (globalThis as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k) : null),
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  };
  (globalThis as { window: unknown }).window = { location: { protocol: "tauri:", host: "" }, __TAURI_INTERNALS__: {} };
  try {
    store.set("ac:server-url", "https://host.example.com:8791");
    store.set("ac:token", "tok");
    assert.equal(isTauri(), true);
    assert.equal(apiBase(), "https://host.example.com:8791");
    assert.deepEqual(wsProtocols(), ["ac-token-b64.dG9r"]); // prefix must match the edge's encoded WS token support
    assert.equal(wsUrl("/api/x"), "wss://host.example.com:8791/api/x"); // https -> wss
    assert.equal(needsDeviceConfig(), false);
    store.delete("ac:token");
    assert.equal(needsDeviceConfig(), true); // missing token -> must configure
    assert.equal(wsProtocols(), undefined); // no token -> no subprotocol offered
  } finally {
    if (origWin === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window: unknown }).window = origWin;
    if (origLS === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
    else (globalThis as { localStorage: unknown }).localStorage = origLS;
  }
});

test("device WebSocket token subprotocol encodes tokens with separator characters", () => {
  const origWin = (globalThis as { window?: unknown }).window;
  const origLS = (globalThis as { localStorage?: unknown }).localStorage;
  const store = new Map<string, string>();
  (globalThis as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k) : null),
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  };
  (globalThis as { window: unknown }).window = { location: { protocol: "tauri:", host: "" }, __TAURI_INTERNALS__: {} };
  try {
    store.set("ac:server-url", "https://host.example.com");
    store.set("ac:token", "client:secret-token");

    const protocols = wsProtocols();
    assert.equal(protocols?.length, 1);
    assert.match(protocols?.[0] ?? "", /^ac-token-b64\.[A-Za-z0-9_-]+$/);
    assert.doesNotMatch(protocols?.[0] ?? "", /:/);
  } finally {
    if (origWin === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window: unknown }).window = origWin;
    if (origLS === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
    else (globalThis as { localStorage: unknown }).localStorage = origLS;
  }
});

test("native platform detection distinguishes browser, macOS, and Android Tauri", () => {
  const origWin = (globalThis as { window?: unknown }).window;
  const origNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const setNavigator = (platform: string, userAgent: string) => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { platform, userAgent },
    });
  };

  try {
    (globalThis as { window: unknown }).window = { location: { protocol: "https:" } };
    setNavigator("MacIntel", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
    assert.equal(isTauri(), false);
    assert.equal(isMacTauri(), false);
    assert.equal(isAndroidTauri(), false);

    (globalThis as { window: unknown }).window = { location: { protocol: "tauri:" }, __TAURI_INTERNALS__: {} };
    setNavigator("MacIntel", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
    assert.equal(isMacTauri(), true);
    assert.equal(isAndroidTauri(), false);

    setNavigator("", "AppleWebKit/605.1.15");
    assert.equal(isMacTauri(), true, "the desktop shell stays macOS when WKWebView omits platform hints");
    assert.equal(isAndroidTauri(), false);

    setNavigator("Linux armv8l", "Mozilla/5.0 (Linux; Android 15)");
    assert.equal(isTauri(), true);
    assert.equal(isMacTauri(), false);
    assert.equal(isAndroidTauri(), true);
  } finally {
    if (origWin === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window: unknown }).window = origWin;
    if (origNavigator) Object.defineProperty(globalThis, "navigator", origNavigator);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
});

test("macOS Tauri production origin is treated as a device runtime", () => {
  const origWin = (globalThis as { window?: unknown }).window;
  (globalThis as { window: unknown }).window = { location: { protocol: "http:", hostname: "tauri.localhost", host: "tauri.localhost" } };
  try {
    assert.equal(isTauri(), true);
  } finally {
    if (origWin === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window: unknown }).window = origWin;
  }
});

test("Android safe-area bridge writes CSS inset variables", () => {
  const style = new Map<string, string>();
  const doc = {
    documentElement: {
      dataset: {} as Record<string, string>,
      style: {
        setProperty: (name: string, value: string) => style.set(name, value),
      },
    },
  };
  const fakeWindow = {
    document: doc,
    agentConsoleAndroidInsets: {
      top: () => 36.25,
      right: () => 0,
      bottom: () => 18.5,
      left: () => -1,
    },
  } as unknown as Window;

  assert.equal(applyAndroidSafeAreaInsets(fakeWindow), true);
  assert.equal(style.get("--android-safe-area-top"), "36.25px");
  assert.equal(style.get("--android-safe-area-right"), "0.00px");
  assert.equal(style.get("--android-safe-area-bottom"), "18.50px");
  assert.equal(style.get("--android-safe-area-left"), "0.00px");
  assert.equal(doc.documentElement.dataset.androidSystemInsets, "true");
});
