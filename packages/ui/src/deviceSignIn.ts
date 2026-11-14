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

export function pairingOrigin(): string {
  const url = new URL(window.location.origin);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    throw new DeviceSignInError(0);
  return url.origin;
}

// Pairing traffic bypasses generic debug/error capture. Only fixed diagnostics leave this boundary.
export async function deviceRequest<T>(route: string, body?: unknown, method = body === undefined ? "GET" : "POST", signal?: AbortSignal): Promise<T> {
  pairingOrigin();
  let response: Response;
  try {
    response = await fetch(`/api/auth/${route}`, { method, credentials: "include", redirect: "error", signal,
      headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
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
