import type { IncomingMessage } from "node:http";
import { MIMEType } from "node:util";
import type { SpeechSynthesisCapabilities } from "@agent-console/shared/speech";
import type { SpeechProviderConfig, SpeechSynthesisVoiceConfig } from "./config.ts";
import { authedFetch } from "./http.ts";

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

async function readBoundedBody(response: Response, limit: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("no body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error("oversized");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    reader.releaseLock();
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  return JSON.parse((await readBoundedBody(response, MAX_RESPONSE_BYTES)).toString("utf8"));
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
): Promise<{ text: string; language: string | null; engine: string | null; label: string | null }> {
  let response: Response;
  try {
    response = await fetch(`${provider.url}/v1/transcriptions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${provider.token}`,
        "content-type": contentType,
        ...(engine ? { "x-speech-engine": engine } : {}),
      },
      body: audio as unknown as RequestInit["body"],
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
      label: typeof parsed.label === "string" && parsed.label ? parsed.label : null,
    };
  } catch {
    throw new SpeechRequestError(502, "speech service returned an invalid response");
  }
}

const SYNTHESIS_FORMAT = "pcm_s16le";
const SYNTHESIS_SAMPLE_RATE = 8000;
const SYNTHESIS_CHANNELS = 1;
const SYNTHESIS_BYTES_PER_SAMPLE = 2;
const MAX_SYNTHESIS_DURATION_SECONDS = 30;
const MAX_SYNTHESIS_REQUEST_BYTES = 8192;
export const SPEECH_SYNTHESIS_CAPABILITIES = {
  formats: [SYNTHESIS_FORMAT],
  sample_rates: [SYNTHESIS_SAMPLE_RATE],
  channels: SYNTHESIS_CHANNELS,
  max_text_length: 1000,
  max_duration_seconds: MAX_SYNTHESIS_DURATION_SECONDS,
  max_bytes: MAX_SYNTHESIS_DURATION_SECONDS * SYNTHESIS_SAMPLE_RATE * SYNTHESIS_CHANNELS * SYNTHESIS_BYTES_PER_SAMPLE,
} satisfies Omit<SpeechSynthesisCapabilities, keyof SpeechSynthesisVoiceConfig>;
export const SPEECH_SYNTHESIS_CONTENT_TYPE = `audio/pcm; rate=${SYNTHESIS_SAMPLE_RATE}; channels=${SYNTHESIS_CHANNELS}`;

const SYNTHESIS_ERRORS = {
  "invalid-synthesis-request": [400, "valid synthesis text and JSON are required"],
  "unsupported-synthesis-voice": [400, "unsupported synthesis voice"],
  "speech-provider-not-found": [404, "speech provider not found"],
  "synthesis-not-offered": [404, "speech synthesis is not offered"],
  "synthesis-input-too-large": [413, "synthesis input exceeds the limit"],
  "unsupported-synthesis-format": [415, "unsupported synthesis format"],
  "speech-provider-busy": [429, "speech service is busy"],
  "speech-provider-rejected": [502, "speech service rejected synthesis"],
  "invalid-provider-audio": [502, "speech service returned invalid audio"],
  "speech-provider-unavailable": [503, "speech service unavailable"],
} as const;

export class SpeechSynthesisError extends SpeechRequestError {
  readonly code: keyof typeof SYNTHESIS_ERRORS;
  constructor(code: keyof typeof SYNTHESIS_ERRORS) {
    const [status, message] = SYNTHESIS_ERRORS[code];
    super(status, message);
    this.code = code;
  }
}

interface SpeechSynthesisRequest {
  readonly text: string;
  readonly format: typeof SYNTHESIS_FORMAT;
  readonly sample_rate: typeof SYNTHESIS_SAMPLE_RATE;
  readonly channels: typeof SYNTHESIS_CHANNELS;
  readonly voice: string;
}

export async function readSpeechSynthesis(
  req: IncomingMessage,
  { voices, default_voice }: SpeechSynthesisVoiceConfig,
): Promise<SpeechSynthesisRequest> {
  if (req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new SpeechSynthesisError("unsupported-synthesis-format");
  }
  if (Number(req.headers["content-length"]) > MAX_SYNTHESIS_REQUEST_BYTES) {
    throw new SpeechSynthesisError("synthesis-input-too-large");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let body: Partial<SpeechSynthesisRequest> | null;
  try {
    // Preserve the socket so an oversized chunked request receives a 413.
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > MAX_SYNTHESIS_REQUEST_BYTES) throw new SpeechSynthesisError("synthesis-input-too-large");
      chunks.push(chunk);
    }
    body = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } catch (error) {
    if (error instanceof SpeechSynthesisError) throw error;
    throw new SpeechSynthesisError("invalid-synthesis-request");
  }
  if (!body || typeof body.text !== "string" || !body.text.trim()) {
    throw new SpeechSynthesisError("invalid-synthesis-request");
  }
  const { text, format, sample_rate, channels, voice = default_voice } = body;
  if (text.length > SPEECH_SYNTHESIS_CAPABILITIES.max_text_length) throw new SpeechSynthesisError("synthesis-input-too-large");
  if (format !== SYNTHESIS_FORMAT || sample_rate !== SYNTHESIS_SAMPLE_RATE || channels !== SYNTHESIS_CHANNELS) {
    throw new SpeechSynthesisError("unsupported-synthesis-format");
  }
  if (!voices.some(({ id }) => id === voice)) {
    throw new SpeechSynthesisError("unsupported-synthesis-voice");
  }
  return { text, format, sample_rate, channels, voice };
}

export async function synthesizeSpeech(
  provider: SpeechProviderConfig,
  input: SpeechSynthesisRequest,
  signal: AbortSignal,
): Promise<Buffer> {
  try {
    return await authedFetch(`${provider.url}/v1/syntheses`, async (response) => {
      try {
        if (response.status === 429) throw new SpeechSynthesisError("speech-provider-busy");
        if (response.status === 503) throw new SpeechSynthesisError("speech-provider-unavailable");
        if (response.status !== 200) throw new SpeechSynthesisError("speech-provider-rejected");
        const type = new MIMEType(response.headers.get("content-type") ?? "");
        const maxBytes = SPEECH_SYNTHESIS_CAPABILITIES.max_bytes;
        if (type.essence !== "audio/pcm" || type.params.get("rate") !== String(input.sample_rate)
          || type.params.get("channels") !== String(input.channels) || Number(response.headers.get("content-length")) > maxBytes) {
          throw new SpeechSynthesisError("invalid-provider-audio");
        }
        const audio = await readBoundedBody(response, maxBytes);
        if (!audio.length || audio.length % SYNTHESIS_BYTES_PER_SAMPLE !== 0) {
          throw new SpeechSynthesisError("invalid-provider-audio");
        }
        return audio;
      } catch (error) {
        await response.body?.cancel().catch(() => {});
        if (error instanceof SpeechSynthesisError || (error instanceof Error && error.name === "AbortError")) throw error;
        throw new SpeechSynthesisError("invalid-provider-audio");
      }
    }, {
      token: provider.token,
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify(input),
      timeoutMs: 30_000,
      redirect: "manual",
      signal,
    });
  } catch (error) {
    if (error instanceof SpeechSynthesisError) throw error;
    throw new SpeechSynthesisError("speech-provider-unavailable");
  }
}
