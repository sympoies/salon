import { isAndroidTauri, isTauri } from "./runtime.ts";

declare global {
  interface Window {
    agentConsoleAndroidImageSave?: { save(id: string, name: string, mime: string, base64: string): void };
  }
}

/** Only already authenticated, bounded image bytes enter the native save UI. */
export async function saveConversationImage(blob: Blob, filename: string, url: string): Promise<void> {
  if (isAndroidTauri()) {
    const bridge = window.agentConsoleAndroidImageSave;
    if (!bridge) throw new Error("Image save unavailable");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset,offset + 8192));
    const id = crypto.randomUUID();
    await new Promise<void>((resolve,reject) => {
      const complete = (event: Event) => {
        const detail = (event as CustomEvent<{id:string;status:string}>).detail;
        if (detail?.id !== id) return;
        window.removeEventListener("agent-console-image-save",complete);
        if (detail.status === "saved" || detail.status === "cancelled") resolve();
        else reject(new Error("Image save failed"));
      };
      window.addEventListener("agent-console-image-save",complete);
      try { bridge.save(id,filename,blob.type,btoa(binary)); }
      catch (error) { window.removeEventListener("agent-console-image-save",complete); reject(error); }
    });
  } else if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("save_conversation_image",{name:filename,mime:blob.type,bytes:Array.from(new Uint8Array(await blob.arrayBuffer()))});
  } else {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }
}
