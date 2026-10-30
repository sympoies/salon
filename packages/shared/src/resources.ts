import { normalizeConversationImages, type ConversationImage } from "./conversationImages.ts";
import { NormalizedSseDecoder } from "./sse.ts";
import { parseSessionNotice } from "./parseSessionNotice.ts";

export type ResourceSubscription =
  | { readonly resource: "sessions"; readonly machines: readonly string[] }
  | { readonly resource: "layout" }
  | { readonly resource: "conversation"; readonly machine: string; readonly id: string };

export function resourceKey(subscription: ResourceSubscription): string {
  return subscription.resource === "conversation"
    ? `conversation/${encodeURIComponent(subscription.machine)}/${encodeURIComponent(subscription.id)}`
    : subscription.resource;
}
// The same normalized latest-page shape as the history HTTP response. Larger
// pages stay on HTTP so an eight-conversation stream remains bounded.
export const CONVERSATION_SNAPSHOT_MAX_BYTES = 60 * 1024;
export interface ConversationSnapshot {
  readonly messages: Array<{ readonly id: string; readonly role: "user" | "assistant" | "goal" | "notice"; readonly text: string; readonly images?: readonly ConversationImage[]; readonly timestamp?: string }>;
  readonly next_cursor?: string;
  readonly older_cursor?: string;
}
export function normalizeConversationSnapshot(value: unknown): ConversationSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.messages) || row.messages.length > 50) return undefined;
  const messages: ConversationSnapshot["messages"] = [];
  const ids = new Set<string>();
  for (const value of row.messages) {
    if (!value || typeof value !== "object") return undefined;
    const item = value as Record<string, unknown>;
    if (typeof item.id !== "string" || !item.id || item.id.length > 160 || ids.has(item.id)
      || !["user", "assistant", "goal", "notice"].includes(String(item.role))
      || typeof item.text !== "string" || item.text.length > 64 * 1024
      || (item.timestamp !== undefined && (typeof item.timestamp !== "string" || item.timestamp.length > 64))) return undefined;
    const images = normalizeConversationImages(item.images);
    // A notice is display-only machine text: it must parse as an envelope and carry no images.
    if (item.role === "notice" && (images.length || !parseSessionNotice(item.text))) continue;
    ids.add(item.id);
    messages.push({ id: item.id, role: item.role as "user" | "assistant" | "goal" | "notice", text: item.text, ...(images.length ? { images } : {}),
      ...(typeof item.timestamp === "string" ? { timestamp: item.timestamp } : {}) });
  }
  const snapshot: ConversationSnapshot = { messages };
  for (const key of ["next_cursor", "older_cursor"] as const) {
    if (row[key] !== undefined && (typeof row[key] !== "string" || row[key].length > 256)) return undefined;
    if (typeof row[key] === "string") Object.assign(snapshot, { [key]: row[key] });
  }
  return new TextEncoder().encode(JSON.stringify(snapshot)).byteLength <= CONVERSATION_SNAPSHOT_MAX_BYTES ? snapshot : undefined;
}
export interface ResourceEvent {
  readonly schema_version: "agent-console.resource-event.v1";
  readonly type: "changed" | "heartbeat" | "unavailable";
  readonly resource: string;
  readonly revision: number;
  readonly conversation?: ConversationSnapshot;
}
export function normalizeResourceEvent(value: unknown): ResourceEvent | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (row.schema_version !== "agent-console.resource-event.v1"
    || !["changed", "heartbeat", "unavailable"].includes(String(row.type))
    || typeof row.resource !== "string" || row.resource.length > 1024
    || !/^(sessions|layout|conversation\/[^/]+\/[^/]+)$/.test(row.resource)
    || !Number.isSafeInteger(row.revision) || Number(row.revision) < 0) return null;
  const conversation = row.type === "changed" && row.resource.startsWith("conversation/")
    ? normalizeConversationSnapshot(row.conversation) : undefined;
  return { schema_version: "agent-console.resource-event.v1", type: row.type as ResourceEvent["type"],
    resource: row.resource, revision: Number(row.revision), ...(conversation ? { conversation } : {}) };
}
export class ResourceSseDecoder extends NormalizedSseDecoder<ResourceEvent> {
  constructor() { super(normalizeResourceEvent); }
}
