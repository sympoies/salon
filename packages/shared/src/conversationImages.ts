/** Opaque daemon selectors; image bytes and paths never enter history snapshots. */
export interface ConversationImage {
  readonly id: string;
  /** Sanitized original display basename, when the runtime has upload metadata. */
  readonly original_name?: string;
  /** Proven provenance; absent for ordinary images and unknown producer values. */
  readonly origin?: ConversationImageOrigin;
  /** Opaque same-history upload identity shared by an attachment and its tool re-read. */
  readonly attachment_ref?: string;
}
export type ConversationImageOrigin = "user_attachment" | "tool_result";
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
/** Matches agent-session's display-name sanitizer; never use a stored path as a name. */
export function sanitizeAttachmentName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const leaf = value.split(/[\\/]/).at(-1)!;
  const name = Array.from(leaf.replace(/\p{Cc}/gu, "")).slice(0, 255).join("").trim();
  return name && name !== "." && name !== ".." ? name : undefined;
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
    if (!isConversationImageId(id)) return [];
    const original_name = sanitizeAttachmentName((image as { original_name?: unknown }).original_name);
    const { origin, attachment_ref: ref } = image as { origin?: unknown; attachment_ref?: unknown };
    return [{ id,
      ...(original_name ? { original_name } : {}),
      ...(origin === "user_attachment" || origin === "tool_result" ? { origin } : {}),
      ...(typeof ref === "string" && /^[A-Za-z0-9._~-]{1,128}$/.test(ref) ? { attachment_ref: ref } : {}) }];
  });
}

/** Display-only parts from nils-cli's managed file contract (f2e8f710). */
export interface ConversationFile {
  readonly kind: "file";
  readonly id: string;
  readonly original_name?: string;
  readonly bytes: number;
  readonly mime?: string;
}

/** Unknown part kinds and extra fields do not change file display metadata. */
export function normalizeConversationFiles(value: unknown): ConversationFile[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 256).flatMap((part: unknown) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return [];
    const { kind, id, original_name, bytes, mime } = part as Record<string, unknown>;
    if (kind !== "file" || typeof id !== "string" || !id || id.length > 200
      || typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) return [];
    const name = sanitizeAttachmentName(original_name);
    return [{ kind, id, bytes, ...(name ? { original_name: name } : {}),
      ...(typeof mime === "string" && mime.length <= 128 ? { mime } : {}) }];
  });
}
