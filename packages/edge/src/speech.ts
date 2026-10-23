import type { IncomingMessage } from "node:http";
import type { SpeechProviderConfig } from "./config.ts";

export const MAX_SPEECH_BYTES = 8 * 1024 * 1024;
export const MAX_SPEECH_DURATION_SECONDS = 90;
const MAX_RESPONSE_BYTES = 16 * 1024;
const CONTENT_TYPES = new Set(["audio/webm", "audio/mp4", "audio/wav", "audio/ogg", "audio/mpeg", "audio/aac", "audio/x-m4a"]);

export class SpeechRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function readSpeechAudio(req: IncomingMessage): Promise<{ audio: Buffer; contentType: string }> {
  const contentType = String(req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (!CONTENT_TYPES.has(contentType)) throw new SpeechRequestError(415, "unsupported audio format");
  const declared = req.headers["content-length"];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > MAX_SPEECH_BYTES)) {
    throw new SpeechRequestError(413, "audio exceeds 8 MiB limit");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_SPEECH_BYTES) throw new SpeechRequestError(413, "audio exceeds 8 MiB limit");
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof SpeechRequestError) throw error;
    throw new SpeechRequestError(400, "audio upload was interrupted");
  }
  if (size === 0) throw new SpeechRequestError(422, "audio is empty");
  return { audio: Buffer.concat(chunks, size), contentType };
}

export async function transcribeSpeech(
  provider: SpeechProviderConfig,
  audio: Buffer,
  contentType: string,
  signal?: AbortSignal,
): Promise<{ text: string; language: string | null }> {
  let response: Response;
  try {
    response = await fetch(`${provider.url}/v1/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${provider.token}`, "content-type": contentType },
      body: audio,
      redirect: "manual",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
    });
  } catch {
    throw new SpeechRequestError(503, "speech service unavailable");
  }
  if (response.status === 429) throw new SpeechRequestError(429, "speech service is busy");
  if (!response.ok) throw new SpeechRequestError(502, "speech service rejected audio");
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_RESPONSE_BYTES) throw new SpeechRequestError(502, "speech service returned an invalid response");
  const reader = response.body?.getReader();
  if (!reader) throw new SpeechRequestError(502, "speech service returned an invalid response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new SpeechRequestError(502, "speech service returned an invalid response");
    }
    chunks.push(value);
  }
  const body = Buffer.concat(chunks, size).toString("utf8");
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (typeof parsed.text !== "string" || parsed.text.length > 12_000 || (parsed.language !== null && parsed.language !== undefined && typeof parsed.language !== "string")) {
      throw new Error("invalid response");
    }
    return { text: parsed.text, language: typeof parsed.language === "string" ? parsed.language.slice(0, 80) : null };
  } catch {
    throw new SpeechRequestError(502, "speech service returned an invalid response");
  }
}
