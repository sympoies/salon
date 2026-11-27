// Host adapter: the same UI runs as a same-origin browser app (cookie auth) and
// as Tauri app shells (WebViews that must reach the tailnet edge cross-origin
// with the client token). This module is the only place that knows the
// difference.
import { isTauri as isTauriRuntime } from "@tauri-apps/api/core";
import { getPrincipalStorageNamespace, unscopedLocalStorageGetItem, unscopedLocalStorageSetItem } from "./storage.ts";
import { conversationImageCache } from "./conversationImageCache.ts";
import { withRequestDeadline } from "./requestDeadline.ts";

const SERVER_KEY = "ac:server-url";
const TOKEN_KEY = "ac:token";
const WS_TOKEN_PROTO_B64_PREFIX = "ac-token-b64.";
const AUTH_TRANSITION_TIMEOUT_MS = 8_000;
let browserCookieCleanup: Promise<void> = Promise.resolve();
export function waitForBrowserCookieCleanup(): Promise<void> {
  return browserCookieCleanup;
}
let connectionConfigGeneration = 0;
const authenticationRejectedListeners = new Set<() => void>();
export function subscribeAuthenticationRejected(listener: () => void): () => void {
  authenticationRejectedListeners.add(listener);
  return () => { authenticationRejectedListeners.delete(listener); };
}

let authenticatedConnection: { generation: number; principal: string | null } | undefined;

export interface ImportedPairingLink {
  readonly origin: string;
  readonly code: string;
  readonly generation: number;
  readonly revision: number;
}
let importedPairingLink: ImportedPairingLink | undefined;
let pairingImportRevision = 0;
const pairingImportListeners = new Set<() => void>();
export const pendingPairingLink = (): ImportedPairingLink | undefined => importedPairingLink;
export function subscribePairingLink(listener: () => void): () => void {
  pairingImportListeners.add(listener);
  return () => { pairingImportListeners.delete(listener); };
}
export function clearPairingLink(expected = importedPairingLink): void {
  if (!importedPairingLink || expected !== importedPairingLink) return;
  importedPairingLink = undefined;
  for (const listener of pairingImportListeners) listener();
}

/** Strict current pairing-link format. Never include input in diagnostics. */
export function parsePairingLink(raw: string): { origin: string; code: string } {
  try {
    if (typeof raw !== "string" || raw.length > 2048 || /[\s\\]/u.test(raw)
      || !/^https:\/\/[^/?#]+\/#pair=[A-HJ-NP-Z2-9]{20}$/.test(raw)) throw new Error();
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search) throw new Error();
    return { origin: url.origin, code: url.hash.slice(6) };
  } catch { throw new Error("Invalid pairing link."); }
}

/** Native shell handoff: memory only; never authenticates or saves a connection. */
export function importPairingLink(url: string): void {
  clearPairingLink();
  const parsed = parsePairingLink(url);
  if (!isTauri()) throw new Error("Pairing link import requires a native shell.");
  importedPairingLink = { ...parsed, generation: connectionConfigGeneration, revision: ++pairingImportRevision };
  for (const listener of pairingImportListeners) listener();
}

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
  // Desktop WKWebView may omit platform hints.
  return !isAndroidTauri() && !isIosTauri();
}

export function isAndroidTauri(): boolean {
  if (!isTauri() || typeof navigator === "undefined") {
    return false;
  }
  const userAgent = window.navigator?.userAgent ?? navigator.userAgent;
  return userAgent.toLowerCase().includes("android");
}

export function isIosTauri(): boolean {
  if (!isTauri() || typeof navigator === "undefined") return false;
  const nav = window.navigator ?? navigator;
  return /iphone|ipad|ipod/i.test(`${nav.userAgent} ${nav.platform}`);
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

export class NativeConnectionStorageError extends Error {
  constructor(operation: "load" | "save") { super(`Could not ${operation} native connection storage.`); }
}

export interface NativeConnectionAdapter {
  load(): Promise<{ serverUrl: string; token: string }>;
  save(connection: { serverUrl: string; token: string }): Promise<void>;
}
let connectionAdapter: NativeConnectionAdapter | undefined;
let adapterConnection = { serverUrl: "", token: "" };
let adapterWrites: Promise<void> = Promise.resolve();

/** Register and load before mounting; failures never use WebView storage. */
export async function registerNativeConnectionAdapter(adapter: NativeConnectionAdapter): Promise<void> {
  connectionAdapter = adapter;
  adapterConnection = { serverUrl: "", token: "" };
  try {
    const loaded = await adapter.load();
    adapterConnection = { serverUrl: normalizeServerUrl(loaded.serverUrl), token: loaded.token.trim() };
  } catch { throw new NativeConnectionStorageError("load"); }
}

export function loadServerUrl(): string {
  return connectionAdapter ? adapterConnection.serverUrl : unscopedLocalStorageGetItem(SERVER_KEY) ?? "";
}
export function saveServerUrl(raw: string): void | Promise<void> {
  const serverUrl = normalizeServerUrl(raw);
  if (loadServerUrl() !== serverUrl) conversationImageCache.clear();
  if (connectionAdapter) {
    return saveAdapterConnection(current => ({ serverUrl, token: serverUrl === current.serverUrl ? current.token : "" }));
  }
  unscopedLocalStorageSetItem(SERVER_KEY, serverUrl);
  connectionConfigGeneration += 1;
  clearPairingLink();
}
export function loadToken(): string {
  return connectionAdapter ? adapterConnection.token : unscopedLocalStorageGetItem(TOKEN_KEY) ?? "";
}
export function saveToken(v: string): void | Promise<void> {
  const token = v.trim();
  if (loadToken() !== token) conversationImageCache.clear();
  if (connectionAdapter) return saveAdapterConnection(current => ({ ...current, token }));
  unscopedLocalStorageSetItem(TOKEN_KEY, token);
  connectionConfigGeneration += 1;
  clearPairingLink();
}
export function saveConnectionValues(raw: string, token?: string): void | Promise<void> {
  const serverUrl = normalizeServerUrl(raw);
  if (connectionAdapter) {
    conversationImageCache.clear();
    return saveAdapterConnection(current => ({
      serverUrl,
      token: token === undefined && serverUrl === current.serverUrl ? current.token : (token ?? "").trim(),
    }));
  }
  saveServerUrl(serverUrl);
  if (token !== undefined) saveToken(token);
}
function saveAdapterConnection(update: (current: { serverUrl: string; token: string }) => { serverUrl: string; token: string }): Promise<void> {
  const adapter = connectionAdapter!;
  connectionConfigGeneration += 1;
  clearPairingLink();
  const write = adapterWrites.then(async () => {
    const connection = update(adapterConnection);
    try { await adapter.save({ ...connection }); }
    catch { throw new NativeConnectionStorageError("save"); }
    adapterConnection = connection;
  });
  adapterWrites = write.catch(() => {});
  return write;
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
  const generation = nativeConnectionConfigGeneration();
  const authenticated = authenticatedConnection;
  const native = isTauri();
  let response: Response;
  if (!native && path === "/api/auth/login") await waitForBrowserCookieCleanup();
  if (native) {
    const base = apiBase();
    const headers = new Headers(init?.headers);
    const token = loadToken();
    const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
    if (generation !== nativeConnectionConfigGeneration()) throw new DOMException("Connection settings changed", "AbortError");
    if (token) headers.set("Authorization", `Bearer ${token}`);
    response = await tauriFetch(`${base}${path}`, { ...init, headers });
  } else {
    response = await fetch(path, { credentials: "include", ...init });
  }
  // Only an authoritative refusal of the active signed-in connection ends it.
  // Network errors, 403 permission denials and stale native requests retain it.
  if (response.status === 401 && authenticated && authenticated === authenticatedConnection
    && authenticated.generation === generation && generation === nativeConnectionConfigGeneration()
    && !/^\/api\/auth\/(?:login|logout|status|pairings)(?:[/?]|$)/.test(path)) {
    // Supported operation routes can forward a daemon's 401 while edge auth is valid.
    const rejected = await withRequestDeadline(async signal => {
      const status = await appFetch("/api/auth/status", { signal });
      if (!status.ok) return false;
      const body = await status.json() as { ok?: boolean; authenticated?: boolean };
      return body.ok === true && body.authenticated === false;
    }, AUTH_TRANSITION_TIMEOUT_MS).catch(() => false);
    if (!rejected || authenticated !== authenticatedConnection
      || generation !== nativeConnectionConfigGeneration()) return response;
    authenticatedConnection = undefined;
    if (native) await saveToken("");
    else browserCookieCleanup = withRequestDeadline(signal =>
      fetch("/api/auth/logout", { method: "POST", credentials: "include", signal }),
    AUTH_TRANSITION_TIMEOUT_MS).then(() => {}, () => {});
    for (const listener of authenticationRejectedListeners) listener();
  }
  return response;
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
