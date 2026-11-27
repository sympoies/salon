import { createHash } from "node:crypto";
import {
  isPromptIncarnation, isPromptRequestId, normalizePromptRequestBinding, type PromptReceiptIdentity,
} from "@agent-console/shared/prompt-receipt";
import type { MachineConfig } from "./config.ts";
import {
  EDGE_FIRST_REPLY_MAX_TEXT_BYTES, type EdgeAssistantReply, type EdgeConversation,
  type EdgeConversationTarget, type EdgeFirstReplyResult,
} from "./extensions.ts";
import type { ExtensionOutboxOptions } from "./extensionOutbox.ts";
import { objectProp } from "./normalize.ts";
import { aggregateSessions, daemonFetch } from "./upstream.ts";

interface ConversationOptions extends Pick<ExtensionOutboxOptions, "store" | "extensionId" | "principalId" | "authorizeRequest" | "authorizeTarget"> {
  canReadHistory(machine: string, historyId: string, provider: string, providerSessionId: string): boolean;
}

type Unavailable = Extract<EdgeFirstReplyResult, { status: "unavailable" }>;
const unavailable = (reason: Unavailable["reason"]): Unavailable => ({ status: "unavailable", reason });
const wrongIncarnation = { status: "wrong_incarnation" } as const;
const HISTORY_LIMIT = 100;

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function boundedText(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= EDGE_FIRST_REPLY_MAX_TEXT_BYTES) return text;
  let end = EDGE_FIRST_REPLY_MAX_TEXT_BYTES;
  while ((bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.toString("utf8", 0, end);
}

async function readHistoryData(machine: MachineConfig, path: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await daemonFetch(machine, path);
    const body = objectProp(response.body);
    return response.status === 200 && body?.ok === true ? objectProp(body.data) : null;
  } catch {
    return null;
  }
}

type TargetObservation =
  | { readonly error: Unavailable | typeof wrongIncarnation }
  | { readonly provider: "codex"; readonly providerSessionId: string; readonly profile?: string };

async function observeTarget(machine: MachineConfig, target: EdgeConversationTarget): Promise<TargetObservation> {
  const observed = await aggregateSessions([machine]);
  const session = observed.sessions.find(row => row.id === target.sessionId);
  if (!session || !isPromptIncarnation(session.session_incarnation) || !validTimestamp(session.created_at)) {
    return { error: unavailable("session_unavailable") };
  }
  if (session.session_incarnation !== target.sessionIncarnation || session.created_at !== target.sessionCreatedAt) {
    return { error: wrongIncarnation };
  }
  const resume = objectProp(session.provider_resume);
  const provider = resume?.provider ?? session.agent;
  if (provider !== "codex") return { error: unavailable("provider_order_unavailable") };
  const providerSessionId = resume?.session_id;
  if (typeof providerSessionId !== "string") return { error: unavailable("history_unavailable") };
  // A transcript shared by two live managed sessions cannot attribute its text
  // to one incarnation. Stopped records do not write to the transcript.
  if (observed.sessions.some(row => row.id !== target.sessionId && row.status === "running"
    && objectProp(row.provider_resume)?.provider === provider
    && objectProp(row.provider_resume)?.session_id === providerSessionId)) {
    return { error: unavailable("history_order_unavailable") };
  }
  return { provider, providerSessionId, profile: typeof session.agent_profile === "string" ? session.agent_profile : undefined };
}

function firstInPage(data: Record<string, unknown>, historyId: string, target: EdgeConversationTarget,
  receipt: PromptReceiptIdentity): EdgeFirstReplyResult {
  // A continuation could hide a conflicting order in the same history.
  if (!Array.isArray(data.messages) || data.next_cursor !== null || data.older_cursor !== null) {
    return unavailable("history_order_unavailable");
  }
  const prefix = historyId + "-";
  let anchor = false;
  let previousPosition = -1;
  let previousOrder = -Infinity;
  let reply: EdgeAssistantReply | undefined;
  for (const value of data.messages) {
    const row = objectProp(value);
    if (!row) return unavailable("history_order_unavailable");
    if (anchor && row.row_class === "compaction") return unavailable("history_order_unavailable");
    // Classified notices/commands and tool-only rows are outside this text-message read.
    if (row.row_class != null || (row.role !== "user" && row.role !== "assistant")) continue;
    const offset = typeof row.id === "string" && row.id.startsWith(prefix) ? row.id.slice(prefix.length) : "";
    const position = Number(offset);
    if (!/^(0|[1-9]\d*)$/.test(offset) || !Number.isSafeInteger(position) || position <= previousPosition) {
      return unavailable("history_order_unavailable");
    }
    previousPosition = position;

    const binding = row.role === "user" ? normalizePromptRequestBinding(row.prompt_request) : undefined;
    if (binding && (anchor || binding.request_id === receipt.request_id)
      && (binding.session_id !== receipt.session_id || binding.session_incarnation !== receipt.session_incarnation)) {
      return wrongIncarnation;
    }
    if (binding?.request_id === receipt.request_id) {
      if (anchor) return unavailable("history_order_unavailable");
      anchor = true;
    }
    if (row.role !== "assistant") continue;
    if (typeof row.text !== "string") return unavailable("history_order_unavailable");
    if (!row.text.trim()) continue;
    // Offsets establish sequence but can move when the transcript is repacked.
    // Use the recorded timestamp as a durable order only if it agrees with
    // the observed assistant sequence and uniquely positions each text row.
    if (!validTimestamp(row.timestamp)) return unavailable("history_order_unavailable");
    const order = Date.parse(row.timestamp);
    if (order <= previousOrder) return unavailable("history_order_unavailable");
    previousOrder = order;
    if (!anchor || reply) continue;
    const eventId = createHash("sha256").update(JSON.stringify([
      target.machine, target.sessionId, target.sessionCreatedAt, target.sessionIncarnation, historyId, row.timestamp, row.text,
    ])).digest("hex");
    reply = { event_id: eventId, order, text: boundedText(row.text), created_at: row.timestamp };
  }
  if (!anchor) return unavailable("receipt_not_in_history");
  return reply ? { status: "found", reply } : { status: "none_yet" };
}

export function createExtensionConversation(options: ConversationOptions): EdgeConversation {
  const { store, principalId, extensionId } = options;
  const requestDenial = () => {
    const failure = options.authorizeRequest(false);
    return failure ? { status: failure.status === 401 ? "unauthenticated" : "forbidden" } as const : undefined;
  };
  return {
    async firstReplyAfter(query) {
      const denied = requestDenial();
      if (denied) return denied;
      if (!store) return unavailable("durability_unavailable");
      const { target, outboxIntentId, receiptRequestId } = query ?? {};
      if (typeof target?.machine !== "string" || !target.machine
        || !isPromptRequestId(target.sessionId) || !isPromptIncarnation(target.sessionIncarnation)
        || !validTimestamp(target.sessionCreatedAt)
        || (outboxIntentId === undefined) === (receiptRequestId === undefined)) return { status: "invalid_request" };
      const selector = isPromptRequestId(outboxIntentId) ? { outboxIntentId }
        : isPromptRequestId(receiptRequestId) ? { receiptRequestId } : null;
      if (!selector) return { status: "invalid_request" };

      // Capture a copy so a caller cannot change the target during observation.
      const exactTarget = { machine: target.machine, sessionId: target.sessionId,
        sessionIncarnation: target.sessionIncarnation, sessionCreatedAt: target.sessionCreatedAt };
      try {
        const entry = store.extensionInputForDelivery(principalId, extensionId, selector);
        if (!entry || entry.target.machine !== exactTarget.machine || entry.target.sessionId !== exactTarget.sessionId) {
          return unavailable("receipt_missing");
        }
        // Reading an owner's replies is not part of the on-behalf capability.
        if (entry.grant.callerPrincipalId !== undefined) return { status: "forbidden" };
        const access = options.authorizeTarget(entry.target, entry.grant);
        if ("code" in access) return { status: "forbidden" };
        if (entry.target.incarnation !== exactTarget.sessionIncarnation) return wrongIncarnation;
        const receipt = entry.item.receipt;
        if (receiptRequestId !== undefined && receipt?.request_id !== receiptRequestId) return unavailable("receipt_missing");
        if (entry.item.state !== "submitted" || receipt?.outcome !== "submitted") return unavailable("receipt_not_submitted");

        const checkAccess = (): EdgeFirstReplyResult | undefined => {
          const requestError = requestDenial();
          if (requestError) return requestError;
          const current = options.authorizeTarget(entry.target, entry.grant);
          if ("code" in current || current.credentialGeneration !== access.credentialGeneration) return { status: "forbidden" };
          return undefined;
        };
        const before = await observeTarget(access.machine, exactTarget);
        const beforeDenial = checkAccess();
        if (beforeDenial) return beforeDenial;
        if ("error" in before) return before.error;
        const { provider, providerSessionId, profile } = before;
        const search = new URLSearchParams({ provider, q: providerSessionId, limit: String(HISTORY_LIMIT) });
        const catalog = await readHistoryData(access.machine, `/history/sessions?${search}`);
        const catalogDenial = checkAccess();
        if (catalogDenial) return catalogDenial;
        if (!Array.isArray(catalog?.sessions)) return unavailable("history_unavailable");
        const matches = catalog.sessions.map(objectProp).filter(row => row?.provider === provider
          && row.provider_session_id === providerSessionId && (row.agent_profile ?? undefined) === profile);
        const historyId = matches[0]?.id;
        if (matches.length !== 1 || typeof historyId !== "string" || !/^h-[a-f0-9]{64}$/.test(historyId)) {
          return unavailable("history_unavailable");
        }
        const canRead = () => options.canReadHistory(exactTarget.machine, historyId, provider, providerSessionId);
        if (!canRead()) return { status: "forbidden" };

        // One daemon read keeps the receipt and order proof in the same snapshot.
        const page = await readHistoryData(access.machine,
          `/history/sessions/${historyId}/messages?direction=latest&limit=${HISTORY_LIMIT}`);
        const historyDenial = checkAccess();
        if (historyDenial) return historyDenial;
        if (!canRead()) return { status: "forbidden" };
        if (!page) return unavailable("history_unavailable");
        const after = await observeTarget(access.machine, exactTarget);
        const afterDenial = checkAccess();
        if (afterDenial) return afterDenial;
        if (!canRead()) return { status: "forbidden" };
        if ("error" in after) return after.error;
        if (after.providerSessionId !== providerSessionId || after.profile !== profile) return unavailable("history_unavailable");
        return firstInPage(page, historyId, exactTarget, receipt);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ERR_SQLITE_ERROR") return unavailable("durability_unavailable");
        throw error;
      }
    },
  };
}
