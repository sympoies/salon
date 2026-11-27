import { isTauri, loadServerUrl, loadToken, nativeConnectionConfigGeneration, saveConnectionValues, waitForBrowserCookieCleanup } from "./runtime.ts";

export interface PairingCreated { readonly id: string; readonly code: string; readonly expires_at: number; }
export interface PairingStatus {
  readonly id: string; readonly principal: string; readonly name: string | null;
  readonly challenge: string | null; readonly verification: string | null;
  readonly delivery: "browser" | "native"; readonly origin: string;
  readonly approved: boolean; readonly unavailable: boolean; readonly expires_at: number;
}
export interface DeviceMetadata {
  readonly id: string; readonly name: string; readonly principal: string;
  readonly created: number; readonly last_used: number; readonly expires_at: number;
  readonly revoked: number | null; readonly current: boolean;
}
export interface DeviceList { readonly can_manage: boolean; readonly devices: readonly DeviceMetadata[]; }
export interface DeviceExchange {
  readonly id: string; readonly principal: string; readonly expires_at: number; readonly credential?: string;
}
export class DeviceSignInError extends Error {
  readonly status: number;
  constructor(status: number) { super("Device sign-in unavailable. Please try again."); this.status = status; }
}

export interface PairingConnection { readonly origin: string; readonly generation: number; }

export function pairingOrigin(server = loadServerUrl()): string {
  let url: URL;
  try { url = new URL(isTauri() ? server : window.location.origin); } catch { throw new DeviceSignInError(0); }
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:"
    && !(!isTauri() && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))))
    throw new DeviceSignInError(0);
  return url.origin;
}

export function pairingConnection(server?: string): PairingConnection {
  return { origin: pairingOrigin(server), generation: nativeConnectionConfigGeneration() };
}
export function pairingConnectionCurrent(connection: PairingConnection): boolean {
  return !isTauri() || connection.generation === nativeConnectionConfigGeneration();
}
export async function installNativePairing(issued: DeviceExchange, connection: PairingConnection): Promise<void> {
  if (!isTauri() || !pairingConnectionCurrent(connection) || pairingOrigin(connection.origin) !== connection.origin
    || !/^salon_device_[A-Za-z0-9_-]{43}$/.test(issued.credential ?? "")) throw new DeviceSignInError(0);
  await saveConnectionValues(connection.origin, issued.credential!);
}

// Pairing traffic bypasses generic debug/error capture. Only fixed diagnostics leave this boundary.
// An explicit connection marks recipient requests: never read the saved bearer for them.
export async function deviceRequest<T>(route: string, body?: unknown, method = body === undefined ? "GET" : "POST", signal?: AbortSignal, connection?: PairingConnection): Promise<T> {
  let response: Response;
  try {
    const target = connection ?? pairingConnection();
    if (!pairingConnectionCurrent(target) || pairingOrigin(target.origin) !== target.origin) throw new DeviceSignInError(0);
    const headers = new Headers({ "content-type": "application/json" });
    const init: RequestInit = { method, credentials: isTauri() ? "omit" : "include", redirect: "error", signal,
      headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
    if (isTauri()) {
      if (!connection && loadToken()) headers.set("authorization", `Bearer ${loadToken()}`);
      const { fetch: nativeFetch } = await import("@tauri-apps/plugin-http");
      if (!pairingConnectionCurrent(target)) throw new DeviceSignInError(0);
      response = await nativeFetch(`${target.origin}/api/auth/${route}`, { ...init, maxRedirections: 0 });
    } else {
      if (route === "pairings/exchange") await waitForBrowserCookieCleanup();
      response = await fetch(`/api/auth/${route}`, init);
    }
    if (!pairingConnectionCurrent(target)) throw new DeviceSignInError(0);
    if (response.url && new URL(response.url).origin !== target.origin) throw new DeviceSignInError(0);
  } catch { throw new DeviceSignInError(0); }
  if (!response.ok) throw new DeviceSignInError(response.status);
  try { return (await response.json() as { data: T }).data; }
  catch { throw new DeviceSignInError(0); }
}

export async function recipientVerifier(): Promise<{ verifier: string; challenge: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("") };
}
