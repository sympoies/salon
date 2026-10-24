import { CONVERSATION_IMAGE_MAX_BYTES, CONVERSATION_IMAGE_TYPES, conversationImageFilename, isConversationImageId } from "@agent-console/shared/conversation-images";
import { appFetch } from "./runtime.ts";

export type ConversationImageData = { readonly state: "ready"; readonly url: string; readonly blob: Blob; readonly filename: string }
  | { readonly state: "loading" | "deleted" | "unavailable" };

export async function fetchConversationImage(machine: string, history: string, image: string, signal: AbortSignal): Promise<ConversationImageData> {
  if (!isConversationImageId(image)) return {state:"unavailable"};
  try {
    const response = await appFetch(`/api/history/sessions/${encodeURIComponent(machine)}/${encodeURIComponent(history)}/images/${encodeURIComponent(image)}`,
      {signal:AbortSignal.any([signal,AbortSignal.timeout(15_000)]),cache:"no-store"});
    if (response.status === 404) {
      const error = await response.json().catch(() => null) as { error?: { code?: string } } | null;
      return {state:error?.error?.code === "history-image-deleted" ? "deleted" : "unavailable"};
    }
    const mime = response.headers.get("content-type")?.split(";")[0]?.trim();
    if (!response.ok || !CONVERSATION_IMAGE_TYPES.some(type => type === mime)
      || Number(response.headers.get("content-length")) > CONVERSATION_IMAGE_MAX_BYTES) return {state:"unavailable"};
    // Native HTTP may expose headers separately from the Response's internal
    // headers. Bind the validated MIME to the original bytes for native saving.
    const blob = (await response.blob()).slice(0, undefined, mime);
    if (signal.aborted || blob.size > CONVERSATION_IMAGE_MAX_BYTES || !blob.size) return {state:"unavailable"};
    const extension = mime === "image/jpeg" ? "jpg" : mime!.slice("image/".length);
    const filename = conversationImageFilename(response.headers.get("content-disposition")) ?? `image-${image.slice(-32,-26)}.${extension}`;
    return {state:"ready",url:URL.createObjectURL(blob),blob,filename};
  } catch { return {state:"unavailable"}; }
}
