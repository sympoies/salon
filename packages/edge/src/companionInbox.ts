import type { IncomingMessage, ServerResponse } from "node:http";
import { isPromptRequestId, normalizePromptReceipt } from "@agent-console/shared/prompt-receipt";
import {
  InboxError, type CompanionInboxStore, type CompanionReply, type CompanionReplyRequest,
  type CompanionReplyStatus, type CompanionTarget,
} from "./companionInboxStore.ts";
import type { MachineConfig } from "./config.ts";
import { authedFetch, sendJson } from "./http.ts";

const MESSAGES_PATH = "/api/prompter/v1/messages";
const ACK_PATH = /^\/api\/prompter\/v1\/messages\/([^/]+)\/ack$/;
const REPLIES_PATH = "/api/prompter/v1/replies";
const REPLY_STATUS_PATH = REPLIES_PATH + "/status";
const RECEIPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MESSAGE_ID = /^(0|[1-9][0-9]{0,19})$/;
const MAX_ID = 0xffffffffffffffffn;
export const COMPANION_INGRESS_PATH = "/api/coordination/prompter/v1/messages";

function validId(value: string): boolean {
  return MESSAGE_ID.test(value) && BigInt(value) <= MAX_ID;
}

export function isDeviceInboxRoute(path: string): boolean {
  return path === MESSAGES_PATH || ACK_PATH.test(path) || path === REPLIES_PATH || path === REPLY_STATUS_PATH;
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
  readonly replyMachine: (target: CompanionTarget, purpose: "observe" | "dispatch") => MachineConfig | undefined;
}

export async function handleDeviceInbox(req: IncomingMessage, res: ServerResponse, url: URL,
  store: CompanionInboxStore, context: DeviceContext): Promise<void> {
  if (!context.authenticated) throw new InboxError("unauthorized");
  const { owner } = context;
  if (!owner) throw new InboxError("device-required");
  if (!context.live()) throw new InboxError("unauthorized");
  if (url.pathname === REPLIES_PATH || url.pathname === REPLY_STATUS_PATH) {
    await handleDeviceReply(req, res, url, store, owner, context);
    return;
  }
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
    || !isPromptRequestId(key)) throw new InboxError("invalid-request");
  if (res.writableEnded || res.destroyed) return;
  sendJson(res, 200, { ok: true, data: store.ack(owner, id, key, state, context.live) });
}

function replyRequest(body: Record<string, unknown>): CompanionReplyRequest {
  const { idempotency_key: key, message_id: id, target, text, confirmation } = body;
  if (Object.keys(body).length !== 5 || !isPromptRequestId(key) || typeof id !== "string" || !validId(id)
    || target === null || typeof target !== "object" || Array.isArray(target) || typeof text !== "string"
    || typeof confirmation !== "string") throw new InboxError("invalid-request");
  const { machine, session_id, incarnation } = target as Record<string, unknown>;
  if (Object.keys(target).length !== 3 || typeof machine !== "string" || typeof session_id !== "string"
    || typeof incarnation !== "string") throw new InboxError("invalid-request");
  if (confirmation !== "physical") throw new InboxError("confirmation-required");
  if (Buffer.byteLength(text) > 4096) throw new InboxError("body-too-large");
  if (!text.trim() || /[\u0000-\u0009\u000b-\u001f\u007f]|\p{Cs}/u.test(text)) {
    throw new InboxError("invalid-request");
  }
  return { idempotency_key: key, message_id: id, target: { machine, session_id, incarnation }, text, confirmation };
}

interface ReplyDaemonEnvelope {
  ok?: boolean;
  data?: { sessions?: unknown; receipt?: unknown; submitted?: unknown; session_incarnation?: unknown };
  error?: { code?: unknown; details?: { receipt?: unknown } };
}

async function requestReplyDaemon(machine: MachineConfig, path: string, body?: Record<string, unknown>) {
  // Preserve the configured destination and keep upstream details out of diagnostics.
  return authedFetch(`${machine.url}${path}`, async response => ({
    status: response.status,
    body: await response.json() as ReplyDaemonEnvelope | null,
  }), {
    token: machine.token, timeoutMs: 10_000, redirect: "error",
    ...(body ? { method: "POST", contentType: "application/json", body: JSON.stringify(body) } : {}),
  }).catch(() => undefined);
}

function promptPath(reply: CompanionReply): string {
  return `/sessions/${encodeURIComponent(reply.session_id)}/prompt/v2`;
}

function replyDaemonStatus(result: Awaited<ReturnType<typeof requestReplyDaemon>>, reply: CompanionReply,
  lookup: boolean): CompanionReplyStatus {
  if (!result) return "uncertain";
  const { status, body } = result;
  const ok = status >= 200 && status < 300 && body?.ok === true;
  const receipt = normalizePromptReceipt(
    lookup || ok ? body?.data?.receipt : body?.error?.details?.receipt,
    { request_id: reply.receipt_id, session_id: reply.session_id, session_incarnation: reply.incarnation },
  );
  if (ok && receipt?.outcome === "submitted"
    && (lookup || (body?.data?.submitted === true && body.data.session_incarnation === reply.incarnation))) return "sent";
  if ((lookup ? ok : status >= 400 && body?.ok === false) && receipt?.outcome === "refused") {
    return receipt.code === "busy" ? "busy" : "refused";
  }
  return "uncertain";
}

async function dispatchReply(store: CompanionInboxStore, owner: string, context: DeviceContext, reply: CompanionReply,
  text: string): Promise<CompanionReplyStatus> {
  const machine = context.replyMachine(reply, "dispatch");
  const snapshot = machine && await requestReplyDaemon(machine, "/sessions");
  const sessions = snapshot?.status === 200 && snapshot.body?.ok === true ? snapshot.body.data?.sessions : undefined;
  const current = Array.isArray(sessions) && sessions.some(session =>
    session?.id === reply.session_id && session?.session_incarnation === reply.incarnation && session?.status === "running");
  if (!context.live()) {
    store.settleReply(owner, reply.receipt_id, "refused");
    throw new InboxError("unauthorized");
  }
  if (!machine || !current || context.replyMachine(reply, "dispatch") !== machine) return "refused";

  const result = await requestReplyDaemon(machine, promptPath(reply), {
    text: `[Companion reply]\n${text}`, request_id: reply.receipt_id,
    expected_session_incarnation: reply.incarnation, require_idle: true,
  });
  return replyDaemonStatus(result, reply, false);
}

async function handleDeviceReply(req: IncomingMessage, res: ServerResponse, url: URL, store: CompanionInboxStore,
  owner: string, context: DeviceContext): Promise<void> {
  if (url.pathname === REPLIES_PATH) {
    if (req.method !== "POST") throw new InboxError("method-not-allowed");
    if (!context.csrfExempt()) throw new InboxError("cross-origin");
    if (url.search) throw new InboxError("invalid-request");

    const input = replyRequest(await readInboxJson(req, res, 32 * 1024));
    if (res.writableEnded || res.destroyed) return;
    const { claimed, reply } = store.claimReply(owner, input, context.live);
    const status = claimed
      ? store.settleReply(owner, reply.receipt_id, await dispatchReply(store, owner, context, reply, input.text))
      : reply.status;
    if (!context.live()) throw new InboxError("unauthorized");
    sendJson(res, 200, { ok: true, data: { receipt_id: reply.receipt_id, status } });
    return;
  }

  if (req.method !== "GET") throw new InboxError("method-not-allowed");
  const entries = [...url.searchParams];
  if (entries.length !== 1) throw new InboxError("invalid-request");
  const [field, value] = entries[0]!;
  if (!(field === "idempotency_key" && isPromptRequestId(value))
    && !(field === "receipt_id" && RECEIPT_ID.test(value))) throw new InboxError("invalid-request");

  const reply = store.lookupReply(owner, { field, value });
  let status = reply.status;
  const machine = status === "uncertain" ? context.replyMachine(reply, "observe") : undefined;
  if (machine) {
    const path = `${promptPath(reply)}/receipts/${reply.receipt_id}?expected_session_incarnation=${encodeURIComponent(reply.incarnation)}`;
    const result = await requestReplyDaemon(machine, path);
    if (!context.live()) throw new InboxError("unauthorized");
    status = store.settleReply(owner, reply.receipt_id, replyDaemonStatus(result, reply, true));
  }
  sendJson(res, 200, { ok: true, data: { receipt_id: reply.receipt_id, status } });
}
