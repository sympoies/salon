import { CONVERSATION_IMAGE_MAX_BYTES, CONVERSATION_IMAGE_TYPES, conversationImageFilename, isConversationImageId } from "@agent-console/shared/conversation-images";
import { appFetch } from "./runtime.ts";

export type ConversationImageData = { readonly state: "ready"; readonly url: string; readonly blob: Blob; readonly filename: string }
  | { readonly state: "unavailable"; readonly reason?: "outside-allowed-roots" }
  | { readonly state: "loading" | "deleted" | "error" };

interface ImageRequest {
  readonly signal: AbortSignal;
  readonly visible: () => boolean;
  readonly send: () => Promise<ConversationImageData>;
  readonly resolve: (data: ConversationImageData) => void;
  readonly abort: () => void;
}
const queue: ImageRequest[] = [];
let active = 0;
function drain() {
  while (active < 3 && queue.length) {
    const visible = queue.findIndex(request => request.visible());
    const request = queue.splice(visible < 0 ? 0 : visible,1)[0]!;
    request.signal.removeEventListener("abort",request.abort);
    active++;
    void request.send().then(request.resolve).finally(() => { active--; drain(); });
  }
}

/** One queue also covers fresh authenticated downloads. Queue time has no timeout. */
export function fetchConversationImage(machine: string, history: string, image: string, signal: AbortSignal,
  visible: () => boolean = () => true): Promise<ConversationImageData> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve({state:"error"}); return; }
    const request: ImageRequest = {signal,visible,resolve,send:() => readConversationImage(machine,history,image,signal),abort:() => {
      const index = queue.indexOf(request);
      if (index >= 0) { queue.splice(index,1); resolve({state:"error"}); }
    }};
    queue.push(request);
    signal.addEventListener("abort",request.abort,{once:true});
    queueMicrotask(drain);
  });
}

async function readConversationImage(machine: string, history: string, image: string, signal: AbortSignal): Promise<ConversationImageData> {
  if (!isConversationImageId(image)) return {state:"unavailable"};
  try {
    const response = await appFetch(`/api/history/sessions/${encodeURIComponent(machine)}/${encodeURIComponent(history)}/images/${encodeURIComponent(image)}`,
      {signal:AbortSignal.any([signal,AbortSignal.timeout(15_000)]),cache:"no-store"});
    if (response.status === 404) {
      const error = await response.json().catch(() => null) as { error?: { code?: string } } | null;
      return {state:error?.error?.code === "history-image-deleted" ? "deleted" : "unavailable"};
    }
    if (response.status === 422) {
      const error = await response.json().catch(() => null) as { error?: { code?: unknown; reason?: unknown } } | null;
      return {state:"unavailable",...(error?.error?.code === "history-image-unavailable" && error.error.reason === "outside-allowed-roots"
        ? {reason:"outside-allowed-roots" as const} : {})};
    }
    if (response.status >= 500 || response.status === 408 || response.status === 429) return {state:"error"};
    const mime = response.headers.get("content-type")?.split(";")[0]?.trim();
    if (!response.ok || !CONVERSATION_IMAGE_TYPES.some(type => type === mime)
      || Number(response.headers.get("content-length")) > CONVERSATION_IMAGE_MAX_BYTES) return {state:"unavailable"};
    // Native HTTP may expose headers separately from the Response's internal
    // headers. Bind the validated MIME to the original bytes for native saving.
    // Pass the real end: Chromium 116 reads an undefined end as 0 and returns
    // an empty blob.
    const original = await response.blob();
    const blob = original.slice(0, original.size, mime);
    if (signal.aborted || blob.size > CONVERSATION_IMAGE_MAX_BYTES || !blob.size) return {state:"unavailable"};
    const extension = mime === "image/jpeg" ? "jpg" : mime!.slice("image/".length);
    const filename = conversationImageFilename(response.headers.get("content-disposition")) ?? `image-${image.slice(-32,-26)}.${extension}`;
    return {state:"ready",url:URL.createObjectURL(blob),blob,filename};
  } catch { return {state:"error"}; }
}
