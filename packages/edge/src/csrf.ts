import type { IncomingMessage, ServerResponse } from "node:http";
import type { EdgeConfig } from "./config.ts";
import { sendJson } from "./http.ts";

type TokenAuthCheck = (req: IncomingMessage) => boolean;

// The single CSRF-gate predicate for every state-changing path: HTTP write
// routes and the WS attach upgrade. Token-bearing requests are not ambient like
// cookies, so they are exempt. Open-access private-network deploys may trust the native
// Tauri app-shell origin while still rejecting arbitrary foreign web origins.
export function createCsrfExempt(config: Pick<EdgeConfig, "openAccess">, tokenAuthed: TokenAuthCheck): TokenAuthCheck {
  return (req) => tokenAuthed(req) || sameOriginHeader(req) || (config.openAccess && tauriAppShellOriginHeader(req));
}

export function forbidCrossOrigin(res: ServerResponse): void {
  sendJson(res, 403, { ok: false, error: { message: "cross-origin request refused" } });
}

// Defense-in-depth CSRF check for state-changing routes: sibling hosts can
// share a registrable domain, so SameSite=Strict alone treats them as same-site.
// When the browser sends an Origin, require it
// to match Host. A missing Origin is allowed for non-browser clients and
// same-origin navigations.
function sameOriginHeader(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) {
    return true;
  }
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function tauriAppShellOriginHeader(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) {
    return false;
  }
  try {
    const u = new URL(origin);
    if (u.protocol === "tauri:") {
      return true;
    }
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname === "tauri.localhost";
  } catch {
    return false;
  }
}

// Same-origin, or the native app shell carrying its token (#1003). A foreign
// web origin is refused even with a token.
export function sameOriginOrNativeApp(req: IncomingMessage, res: ServerResponse, tokenAuthed: boolean): boolean {
  if (sameOriginHeader(req) || (tokenAuthed && tauriAppShellOriginHeader(req))) {
    return true;
  }
  forbidCrossOrigin(res);
  return false;
}

export function sameOrigin(req: IncomingMessage, res: ServerResponse): boolean {
  if (sameOriginHeader(req)) {
    return true;
  }
  forbidCrossOrigin(res);
  return false;
}
