/** Opaque daemon selectors; image bytes and paths never enter history snapshots. */
export interface ConversationImage { readonly id: string }
export const CONVERSATION_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const CONVERSATION_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export function isConversationImageId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{16}\.\d{1,20}\.(?:[0-9]|1[0-5])\.[a-f0-9]{32}$/.test(value);
}
export function normalizeConversationImages(value: unknown): ConversationImage[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0,16).flatMap((image: unknown) => {
    const id = image && typeof image === "object" ? (image as { id?: unknown }).id : undefined;
    return isConversationImageId(id) ? [{ id }] : [];
  });
}
