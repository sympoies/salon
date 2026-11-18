import type { IncomingMessage, ServerResponse } from "node:http";
import { InboxError, type CompanionInboxStore } from "./companionInboxStore.ts";
import { sendJson } from "./http.ts";

const MESSAGES_PATH = "/api/prompter/v1/messages";
const ACK_PATH = /^\/api\/prompter\/v1\/messages\/([^/]+)\/ack$/;
const ACK_KEY = /^[A-Za-z0-9._-]{1,128}$/;
const MESSAGE_ID = /^(0|[1-9][0-9]{0,19})$/;
const MAX_ID = 0xffffffffffffffffn;
export const COMPANION_INGRESS_PATH = "/api/coordination/prompter/v1/messages";

function validId(value: string): boolean {
  return MESSAGE_ID.test(value) && BigInt(value) <= MAX_ID;
}

export function isDeviceInboxRoute(path: string): boolean {
  return path === MESSAGES_PATH || ACK_PATH.test(path);
}

// Keep parser, storage and upstream diagnostics out of the general edge logger.
export async function handleInboxRequest(res: ServerResponse, handle: () => Promise<void>): Promise<void> {
  try {
    await handle();
  } catch (error) {
    const failure = error instanceof InboxError ? error : new InboxError("inbox-error");
    if (!res.headersSent) sendJson(res, failure.status, { ok: false, error: { code: failure.code, message: failure.message } });
  }
}

export async function readInboxJson(req: IncomingMessage, res: ServerResponse, limit: number): Promise<Record<string, unknown>> {
  if (req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new InboxError("invalid-request");
  }
  const tooLarge = (): never => {
    if (!res.headersSent) res.setHeader("connection", "close");
    throw new InboxError("body-too-large");
  };
  if (Number(req.headers["content-length"]) > limit) tooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  // Keep the socket available for the typed 413 on an oversized chunked request.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const bytes = chunk as Buffer;
    size += bytes.length;
    if (size > limit) tooLarge();
    chunks.push(bytes);
  }
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new InboxError("invalid-request"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new InboxError("invalid-request");
  return raw as Record<string, unknown>;
}

interface DeviceContext {
  readonly authenticated: boolean;
  readonly owner: string | undefined;
  readonly live: () => boolean;
  readonly csrfExempt: () => boolean;
}

export async function handleDeviceInbox(req: IncomingMessage, res: ServerResponse, url: URL,
  store: CompanionInboxStore, context: DeviceContext): Promise<void> {
  if (!context.authenticated) throw new InboxError("unauthorized");
  const { owner } = context;
  if (!owner) throw new InboxError("device-required");
  if (!context.live()) throw new InboxError("unauthorized");
  if (url.pathname === MESSAGES_PATH) {
    if (req.method !== "GET") throw new InboxError("method-not-allowed");
    const query = url.searchParams;
    if ([...query.keys()].some(name => name !== "cursor" && name !== "limit")
      || query.getAll("cursor").length > 1 || query.getAll("limit").length > 1) throw new InboxError("invalid-request");
    const cursor = query.get("cursor");
    const limit = query.get("limit") ?? "20";
    if ((cursor !== null && !validId(cursor)) || !/^(?:[1-9][0-9]?|100)$/.test(limit)) throw new InboxError("invalid-request");
    sendJson(res, 200, { ok: true, data: store.list(owner, cursor, Number(limit)) });
    return;
  }
  if (req.method !== "POST") throw new InboxError("method-not-allowed");
  if (!context.csrfExempt()) throw new InboxError("cross-origin");
  const id = ACK_PATH.exec(url.pathname)?.[1];
  if (!id || !validId(id) || url.search) throw new InboxError("invalid-request");
  const body = await readInboxJson(req, res, 1024);
  const { state, idempotency_key: key } = body;
  if (Object.keys(body).length !== 2 || (state !== "displayed" && state !== "read")
    || typeof key !== "string" || !ACK_KEY.test(key)) throw new InboxError("invalid-request");
  if (res.writableEnded || res.destroyed) return;
  sendJson(res, 200, { ok: true, data: store.ack(owner, id, key, state, context.live) });
}
