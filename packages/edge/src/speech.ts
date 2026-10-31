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

const ENGINE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The optional engine selector: absent, or a plain token. */
export function readSpeechEngine(req: IncomingMessage): string | undefined {
  const raw = req.headers["x-speech-engine"];
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !ENGINE_TOKEN.test(raw)) throw new SpeechRequestError(400, "invalid speech engine");
  return raw;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("no body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("oversized");
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
}

export interface SpeechEngineList {
  readonly engines: readonly { id: string; label: string; available: boolean }[];
  readonly default: string;
}

/** Forward the upstream engine list; null means a legacy server without the route. */
export async function listSpeechEngines(provider: SpeechProviderConfig, signal?: AbortSignal): Promise<SpeechEngineList | null> {
  let response: Response;
  try {
    response = await fetch(`${provider.url}/v1/engines`, {
      headers: { authorization: `Bearer ${provider.token}` },
      redirect: "manual",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    });
  } catch {
    throw new SpeechRequestError(503, "speech service unavailable");
  }
  if (response.status === 404) return null;
  try {
    if (!response.ok) throw new Error("rejected");
    const parsed = await readBoundedJson(response) as { engines?: unknown; default?: unknown };
    if (!Array.isArray(parsed.engines) || typeof parsed.default !== "string" || !ENGINE_TOKEN.test(parsed.default)) throw new Error("invalid");
    const engines = parsed.engines.map((item: { id?: unknown; label?: unknown; available?: unknown }) => {
      if (typeof item?.id !== "string" || !ENGINE_TOKEN.test(item.id) || typeof item.label !== "string" || typeof item.available !== "boolean") throw new Error("invalid");
      return { id: item.id, label: item.label.slice(0, 80), available: item.available };
    });
    return { engines, default: parsed.default };
  } catch {
    throw new SpeechRequestError(502, "speech service returned an invalid response");
  }
}

export async function transcribeSpeech(
  provider: SpeechProviderConfig,
  audio: Buffer,
  contentType: string,
  engine: string | undefined,
  signal?: AbortSignal,
): Promise<{ text: string; language: string | null; engine: string | null }> {
  let response: Response;
  try {
    response = await fetch(`${provider.url}/v1/transcriptions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${provider.token}`,
        "content-type": contentType,
        ...(engine ? { "x-speech-engine": engine } : {}),
      },
      body: audio,
      redirect: "manual",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
    });
  } catch {
    throw new SpeechRequestError(503, "speech service unavailable");
  }
  if (response.status === 429) throw new SpeechRequestError(429, "speech service is busy");
  if (response.status === 400 || response.status === 503) {
    let message = response.status === 400 ? "speech engine is not recognized" : "speech engine is unavailable";
    try {
      const failure = await readBoundedJson(response) as { error?: { message?: unknown } };
      if (typeof failure.error?.message === "string" && failure.error.message.trim()) message = failure.error.message.slice(0, 300);
    } catch { /* keep the generic message */ }
    throw new SpeechRequestError(response.status, message);
  }
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
    return {
      text: parsed.text,
      language: typeof parsed.language === "string" ? parsed.language.slice(0, 80) : null,
      engine: typeof parsed.engine === "string" && ENGINE_TOKEN.test(parsed.engine) ? parsed.engine : null,
    };
  } catch {
    throw new SpeechRequestError(502, "speech service returned an invalid response");
  }
}
