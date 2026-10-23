// Client for the optional single-user host layout store.
//
// The dashboard lets the user arrange session panes; that arrangement should
// persist across devices, not just in one browser's localStorage. The order is
// a single ranked list of session keys ("machine/id") — each device fills its
// own grid (desktop 2/3/4/6, mobile 1-4) from that one ranking.
//
// In multi-user mode the edge persists that order itself, per principal, in the
// `principal_layout` table of `access.sqlite` (AGENT_CONSOLE_STATE_DB, on the
// `agent-console-state` volume in the deployed stack), and serves it from
// `GET/PUT /api/layout` in `server.ts` without calling this module.
//
// Outside multi-user mode (legacy token or open access) the route can instead
// proxy to a host store configured by AGENT_CONSOLE_LAYOUT_URL
// (`config.layout`): the edge both fetches (`GET /layout`) and stores
// (`PUT /layout`) the order through the functions below. This integration is
// optional. With AGENT_CONSOLE_LAYOUT_URL unset, or the store down, the route
// answers `reachable: false` (never a 500) and the UI keeps its browser-local
// order.
import { normalizeLayoutDocument } from "@agent-console/shared/api";
import type { LayoutDocument, LayoutWriteRequest, LayoutWriteResult } from "@agent-console/shared/api";
import { withHostReaderJson, type HostReader } from "./hostReader.ts";
import { asString, objectProp } from "./normalize.ts";

export {
  normalizeOrder,
  normalizeRevision,
} from "@agent-console/shared/api";
export type { LayoutDocument, LayoutWriteRequest, LayoutWriteResult } from "@agent-console/shared/api";

// The order payload is a tiny list of keys. Cap the body read so a buggy or
// compromised loopback store can't OOM the shared edge process (the abort
// timeout bounds time; this bounds memory).
const MAX_RESPONSE_BYTES = 256 * 1024;

function hasOrderPayload(body: unknown): boolean {
  return Array.isArray(body) || Array.isArray(objectProp(body)?.order);
}

// Fetch the stored order from the host layout store. Throws on any
// transport/status/parse/size failure so the caller can report the store as
// unreachable (never a 500). The abort timeout spans the body read too, the body
// is size-capped, and redirects are refused so a misbehaving loopback store
// cannot pivot the edge's bearer-authenticated request to another host.
export async function fetchLayoutOrder(reader: HostReader): Promise<LayoutDocument> {
  return withHostReaderJson(
    reader,
    "/layout",
    (body) => normalizeLayoutDocument(body),
    {
      maxBytes: MAX_RESPONSE_BYTES,
      statusLabel: "layout store status",
      sizeErrorMessage: "layout store response too large",
      redirect: "error",
    },
  );
}

// Store a new order in the host layout store. The order is already normalized by
// the caller. Throws on any transport/status failure so the caller can report
// the store as unreachable (the write is then a no-op, never a 500). Redirects
// are refused for the same reason as the read path.
export async function writeLayoutOrder(reader: HostReader, request: LayoutWriteRequest): Promise<LayoutWriteResult> {
  const body: { order: readonly string[]; base_revision?: number; reason?: string } = { order: request.order };
  if (request.baseRevision !== null && request.baseRevision !== undefined) {
    body.base_revision = request.baseRevision;
  }
  if (request.reason) {
    body.reason = request.reason;
  }
  return withHostReaderJson(
    reader,
    "/layout",
    (parsed, res) => {
      if (res.status === 409) {
        const doc = normalizeLayoutDocument(parsed);
        const error = asString(objectProp(parsed)?.error) ?? undefined;
        return { ...doc, conflict: true, error };
      }
      const doc = normalizeLayoutDocument(parsed);
      return {
        order: hasOrderPayload(parsed) ? doc.order : [...request.order],
        revision: doc.revision,
        conflict: false,
      };
    },
    {
      method: "PUT",
      jsonBody: JSON.stringify(body),
      redirect: "error",
      maxBytes: MAX_RESPONSE_BYTES,
      statusLabel: "layout store status",
      sizeErrorMessage: "layout store response too large",
      emptyBody: (res: Response) => {
        if (res.status === 409) {
          throw new Error("layout conflict response was empty");
        }
        return null;
      },
      ok: (res) => res.ok || res.status === 409,
    },
  );
}
