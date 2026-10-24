/** Opaque daemon selectors; image bytes and paths never enter history snapshots. */
export interface ConversationImage { readonly id: string }
export const CONVERSATION_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const CONVERSATION_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
/** Bounded basename from an authenticated image response, never a local path. */
export function conversationImageFilename(disposition: string | null): string | undefined {
  if (!disposition || disposition.length > 1024) return undefined;
  const encoded = /(?:^|;)\s*filename\*=UTF-8''([^;]*)/i.exec(disposition)?.[1];
  let name: string | undefined;
  try {
    name = encoded !== undefined ? decodeURIComponent(encoded.trim())
      : /(?:^|;)\s*filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/i.exec(disposition)?.slice(1).find(value => value !== undefined)?.replace(/\\(.)/g,"$1");
  } catch { return undefined; }
  if (!name || /[\u0000-\u001f\u007f/\\]/.test(name)) return undefined;
  name = name.trim();
  return name.length <= 255 && name !== "." && name !== ".." ? name || undefined : undefined;
}
export function isConversationImageId(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 96) return false;
  const match = /^[a-f0-9]{16}\.(\d{1,20})\.(?:[0-9]|1[0-5]|u(0|[1-9]\d{0,19})-(0|[1-9]\d{0,19}))\.[a-f0-9]{32}$/.exec(value);
  if (!match) return false;
  return [match[2], match[3]].filter((part): part is string => part !== undefined)
    .every(part => part.length < 20 || part <= "18446744073709551615");
}
export function normalizeConversationImages(value: unknown): ConversationImage[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0,16).flatMap((image: unknown) => {
    const id = image && typeof image === "object" ? (image as { id?: unknown }).id : undefined;
    return isConversationImageId(id) ? [{ id }] : [];
  });
}
