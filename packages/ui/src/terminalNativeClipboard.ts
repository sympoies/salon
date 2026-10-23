import { invoke } from "@tauri-apps/api/core";
import { isMacTauri } from "./runtime.ts";

export interface NativeClipboardFilePayload {
  readonly name: string;
  readonly contentType: string;
  readonly dataBase64: string;
}

export async function readMacosClipboardFiles(): Promise<File[]> {
  if (!isMacTauri()) {
    return [];
  }

  const payloads = await invoke<NativeClipboardFilePayload[]>("read_macos_clipboard_files");
  return payloads
    .map(nativeClipboardPayloadToFile)
    .filter((file): file is File => file !== null);
}

export function isMacosFilePasteCandidate(types: readonly string[], text: string): boolean {
  if (text.trimStart().startsWith("file://")) {
    return true;
  }
  return types.some((type) => {
    const normalized = type.toLowerCase();
    return normalized === "files" || normalized.includes("file-url") || normalized.includes("filename");
  });
}

export function nativeClipboardPayloadToFile(payload: NativeClipboardFilePayload): File | null {
  const name = payload.name.trim();
  if (!name) {
    return null;
  }

  const binary = atob(payload.dataBase64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new File([bytes], name, { type: payload.contentType || "application/octet-stream" });
}
