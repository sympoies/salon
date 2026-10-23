// Host adapter: the same UI runs as a same-origin browser app (cookie auth) and
// as Tauri app shells (WebViews that must reach the tailnet edge cross-origin
// with the client token). This module is the only place that knows the
// difference.
import { isTauri as isTauriRuntime } from "@tauri-apps/api/core";
import { getPrincipalStorageNamespace, unscopedLocalStorageGetItem, unscopedLocalStorageSetItem } from "./storage.ts";

const SERVER_KEY = "ac:server-url";
const TOKEN_KEY = "ac:token";
const WS_TOKEN_PROTO_B64_PREFIX = "ac-token-b64.";
let connectionConfigGeneration = 0;
let authenticatedConnection: { generation: number; principal: string | null } | undefined;

export function nativeConnectionConfigGeneration(): number {
  return connectionConfigGeneration;
}

export function recordNativeAuthentication(generation: number, authenticated: boolean, principal: string | null): void {
  if (generation !== connectionConfigGeneration) return;
  authenticatedConnection = authenticated ? { generation, principal } : undefined;
}

// Saving credentials invalidates the generation immediately. A successful auth
// check must also match the activated principal before its durable queue can run.
export function nativePrincipalIsActive(): boolean {
  return !isTauri() || (authenticatedConnection?.generation === connectionConfigGeneration
    && authenticatedConnection.principal === getPrincipalStorageNamespace());
}

export function isTauri(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  if (isTauriRuntime()) {
    return true;
  }
  return (
    window.location.protocol === "tauri:" ||
    window.location.hostname === "tauri.localhost" ||
    "__TAURI_INTERNALS__" in window ||
    "__TAURI__" in window
  );
}

export function isMacTauri(): boolean {
  if (!isTauri() || typeof navigator === "undefined") {
    return false;
  }
  // The shipped native shells are macOS and Android. WKWebView may omit both
  // navigator.platform and the macOS tokens from its user agent, so treat any
  // non-Android Tauri runtime as the desktop shell instead of depending on
  // browser-controlled platform hints.
  return !isAndroidTauri();
}

export function isAndroidTauri(): boolean {
  if (!isTauri() || typeof navigator === "undefined") {
    return false;
  }
  const userAgent = window.navigator?.userAgent ?? navigator.userAgent;
  return userAgent.toLowerCase().includes("android");
}

export interface AndroidSafeAreaBridge {
  top(): number;
  right(): number;
  bottom(): number;
  left(): number;
}

declare global {
  interface Window {
    agentConsoleAndroidInsets?: AndroidSafeAreaBridge;
    agentConsoleAndroidBoot?: { elapsedMs(): number };
  }
}

// Android counts native activity/WebView initialization too. Older shells and
// desktop/browser clients fall back to the document's monotonic boot clock.
export function appBootElapsedMs(): number {
  const elapsed = typeof window !== "undefined" && window.agentConsoleAndroidBoot
    ? window.agentConsoleAndroidBoot.elapsedMs()
    : performance.now();
  return Math.max(0, elapsed);
}

function cssInset(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  return `${Math.max(0, Number.isFinite(n) ? n : 0).toFixed(2)}px`;
}

export function applyAndroidSafeAreaInsets(targetWindow: Window = window): boolean {
  const bridge = targetWindow.agentConsoleAndroidInsets;
  if (!bridge) return false;

  const style = targetWindow.document.documentElement.style;
  style.setProperty("--android-safe-area-top", cssInset(bridge.top()));
  style.setProperty("--android-safe-area-right", cssInset(bridge.right()));
  style.setProperty("--android-safe-area-bottom", cssInset(bridge.bottom()));
  style.setProperty("--android-safe-area-left", cssInset(bridge.left()));
  targetWindow.document.documentElement.dataset.androidSystemInsets = "true";
  return true;
}

export function installAndroidSafeAreaInsets(): void {
  if (typeof window === "undefined" || !isTauri()) return;

  const apply = () => applyAndroidSafeAreaInsets(window);
  for (const delay of [0, 100, 500, 1000]) window.setTimeout(apply, delay);
  window.addEventListener("resize", apply);
  document.addEventListener("visibilitychange", apply);
}

export function normalizeServerUrl(raw: string): string {
  const t = raw.trim();
  if (t === "") return "";
  const withProto = /^https?:\/\//i.test(t) ? t : `https://${t}`;
  try {
    const u = new URL(withProto);
    return `${u.protocol}//${u.host}`; // strip path/query/hash/trailing slash
  } catch {
    return "";
  }
}

export function loadServerUrl(): string {
  return unscopedLocalStorageGetItem(SERVER_KEY) ?? "";
}
export function saveServerUrl(raw: string): void {
  unscopedLocalStorageSetItem(SERVER_KEY, normalizeServerUrl(raw));
  connectionConfigGeneration += 1;
}
export function loadToken(): string {
  return unscopedLocalStorageGetItem(TOKEN_KEY) ?? "";
}
export function saveToken(v: string): void {
  unscopedLocalStorageSetItem(TOKEN_KEY, v.trim());
  connectionConfigGeneration += 1;
}

// Native clients need a configured server URL + token before they can talk to
// the edge; in the browser build everything is same-origin.
export function needsDeviceConfig(): boolean {
  return isTauri() && (loadServerUrl() === "" || loadToken() === "");
}

// HTTP base: "" (same-origin) in the browser, the configured server in native
// apps.
export function apiBase(): string {
  return isTauri() ? loadServerUrl() : "";
}

// Fetch a path against the right origin with the right auth: same-origin +
// cookie in the browser; the configured server + a bearer token via plugin-http
// (which bypasses the WebView's CORS) in native apps.
export async function appFetch(path: string, init?: RequestInit): Promise<Response> {
  if (isTauri()) {
    const generation = nativeConnectionConfigGeneration();
    const base = apiBase();
    const headers = new Headers(init?.headers);
    const token = loadToken();
    const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
    if (generation !== nativeConnectionConfigGeneration()) throw new DOMException("Connection settings changed", "AbortError");
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return tauriFetch(`${base}${path}`, { ...init, headers });
  }
  return fetch(path, { credentials: "include", ...init });
}

// WebSocket URL for a path: same-origin in the browser, the configured server
// (http->ws, https->wss) in native apps.
export function wsUrl(path: string): string {
  if (isTauri()) {
    const base = apiBase();
    const wsBase = base.replace(/^http/i, "ws");
    return `${wsBase}${path}`;
  }
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}${path}`;
}

// Legacy WS subprotocol fallback: native WebViews can't set WS headers, and the
// token must not appear in the URL. New native attach attempts prefer a one-time
// ticket, but this remains for mixed-version client/server compatibility. In the
// browser the httpOnly cookie authenticates the upgrade, so no subprotocol is
// needed.
export function wsProtocols(): string[] | undefined {
  if (isTauri()) {
    const token = loadToken();
    if (token) return [`${WS_TOKEN_PROTO_B64_PREFIX}${base64UrlEncodeUtf8(token)}`];
  }
  return undefined;
}

function base64UrlEncodeUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
