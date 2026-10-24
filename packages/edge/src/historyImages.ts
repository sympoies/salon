import type { ServerResponse } from "node:http";
import { CONVERSATION_IMAGE_MAX_BYTES, CONVERSATION_IMAGE_TYPES, isConversationImageId } from "@agent-console/shared/conversation-images";
import type { MachineConfig } from "./config.ts";
import { authedFetch, sendJson } from "./http.ts";

class ImageUnavailableError extends Error {}

async function readBounded(response: Response, limit: number): Promise<Buffer> {
  if (Number(response.headers.get("content-length")) > limit) { await response.body?.cancel(); throw new ImageUnavailableError("Image unavailable"); }
  const chunks: Buffer[] = [];
  let bytes = 0;
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limit) throw new ImageUnavailableError("Image unavailable");
      chunks.push(Buffer.from(next.value));
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks,bytes);
}

/** Reuses edge auth/ownership and daemon credentials; never accepts a file path. */
export async function forwardHistoryImage(res: ServerResponse, machine: MachineConfig, history: string, image: string): Promise<void> {
  res.setHeader("cache-control","private, no-store");
  res.setHeader("x-content-type-options","nosniff");
  const unavailable = () => sendJson(res,422,{ok:false,error:{code:"history-image-unavailable",message:"Image unavailable"}});
  const failed = () => sendJson(res,502,{ok:false,error:{code:"history-image-read-failed",message:"Image service unavailable"}});
  if (!isConversationImageId(image)) { unavailable(); return; }
  const controller = new AbortController();
  const onClose = () => { if (!res.writableFinished) controller.abort(); };
  res.once("close",onClose);
  try {
    await authedFetch(`${machine.url}/history/sessions/${encodeURIComponent(history)}/images/${encodeURIComponent(image)}`,async (response) => {
      if (response.status !== 200) {
        if (response.status !== 404 && response.status !== 422) { await response.body?.cancel(); failed(); return; }
        const bytes = await readBounded(response,16 * 1024);
        let code: unknown;
        try { code = (JSON.parse(bytes.toString("utf8")) as {error?:{code?:unknown}}).error?.code; } catch { /* old daemon or malformed upstream */ }
        if (response.status === 404 && code === "history-image-deleted") {
          sendJson(res,404,{ok:false,error:{code:"history-image-deleted",message:"Image deleted"}});
        } else unavailable();
        return;
      }
      const mime = response.headers.get("content-type")?.split(";")[0]?.trim();
      if (!CONVERSATION_IMAGE_TYPES.some(type => type === mime)) { await response.body?.cancel(); unavailable(); return; }
      const bytes = await readBounded(response,CONVERSATION_IMAGE_MAX_BYTES);
      res.writeHead(200,{"content-type":mime!,"content-length":bytes.byteLength});
      res.end(bytes);
    },{token:machine.token,timeoutMs:10_000,redirect:"error",signal:controller.signal});
  } catch (error) {
    if (!res.destroyed && !res.headersSent) { if (error instanceof ImageUnavailableError) unavailable(); else failed(); }
  } finally { res.off("close",onClose); }
}
