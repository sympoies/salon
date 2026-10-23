import type { IncomingMessage, ServerResponse } from "node:http";
import { Transform } from "node:stream";

export type FetchRedirect = "error" | "follow" | "manual";

export interface AuthedFetchOptions {
  readonly token?: string | null;
  readonly method?: string;
  readonly body?: string | Buffer;
  readonly contentType?: string;
  readonly timeoutMs: number;
  readonly redirect?: FetchRedirect;
  readonly signal?: AbortSignal;
}

export async function authedFetch<T>(
  url: string,
  consume: (res: Response) => Promise<T> | T,
  options: AuthedFetchOptions,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.token) {
    headers.authorization = `Bearer ${options.token}`;
  }
  if (options.contentType) {
    headers["content-type"] = options.contentType;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const res = await fetch(url, {
      method: options.method,
      headers,
      body: options.body,
      signal: options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal,
      redirect: options.redirect,
    });
    return await consume(res);
  } finally {
    clearTimeout(timer);
  }
}

// Minimal path matcher: `/api/sessions/:machine/:id` against a concrete path.
// Returns the extracted params, or null when the pattern does not match.
export function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const pparts = pattern.split("/");
  const uparts = pathname.split("/");
  if (pparts.length !== uparts.length) {
    return null;
  }
  const params: Record<string, string> = {};
  for (let i = 0; i < pparts.length; i++) {
    const p = pparts[i] as string;
    const u = uparts[i] as string;
    if (p.startsWith(":")) {
      if (u === "") {
        return null;
      }
      try {
        params[p.slice(1)] = decodeURIComponent(u);
      } catch {
        params[p.slice(1)] = u;
      }
    } else if (p !== u) {
      return null;
    }
  }
  return params;
}

// Narrow a matchPath result to a record whose declared keys are all present.
// Returns null if the match failed or any required param is missing, so callers
// get `string` (not `string | undefined`) params under noUncheckedIndexedAccess.
export function requireParams<K extends string>(
  m: Record<string, string> | null,
  keys: readonly K[],
): Record<K, string> | null {
  if (!m) {
    return null;
  }
  const out = {} as Record<K, string>;
  for (const k of keys) {
    const v = m[k];
    if (v === undefined) {
      return null;
    }
    out[k] = v;
  }
  return out;
}

// The failure envelope a route produced, kept just long enough for the debug
// ring to project its bounded fields after the handler returns. The envelope
// itself is not retained anywhere: the map is keyed by the live response and
// holds the last failing body only until that response is garbage collected.
const sentErrorEnvelopes = new WeakMap<ServerResponse, unknown>();

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  if (body && typeof body === "object" && (body as { ok?: unknown }).ok === false) {
    sentErrorEnvelopes.set(res, body);
  }
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

export function sentErrorEnvelope(res: ServerResponse): unknown {
  return sentErrorEnvelopes.get(res);
}

export async function readJsonBody(req: IncomingMessage, limitBytes = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > limitBytes) {
      throw new Error("request body too large");
    }
    chunks.push(buf);
  }
  if (total === 0) {
    return undefined;
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function readRawBody(req: IncomingMessage, limitBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer);
    total += buf.length;
    if (total > limitBytes) {
      throw new Error("request body too large");
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export interface LimitedRequestBody {
  readonly body: AsyncIterable<Uint8Array>;
  readonly signal: AbortSignal;
  readonly cancel: () => void;
  readonly limitExceeded: () => boolean;
}

export function streamRequestBody(req: IncomingMessage, limitBytes: number): LimitedRequestBody {
  let total = 0;
  let exceeded = false;
  const abort = new AbortController();
  const body = new Transform({
    transform(chunk: Buffer | Uint8Array, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (total > limitBytes) {
        exceeded = true;
        const error = new Error("request body too large");
        abort.abort(error);
        callback(error);
        return;
      }
      callback(null, bytes);
    },
  });
  const abortForwarding = (reason: Error): void => {
    if (!abort.signal.aborted) abort.abort(reason);
    if (!body.destroyed) body.destroy(reason);
  };
  const onAborted = (): void => abortForwarding(new Error("request body aborted"));
  const onError = (error: Error): void => abortForwarding(error);
  const onClose = (): void => {
    if (!req.complete) abortForwarding(new Error("request body closed before completion"));
  };
  const stopForwarding = (): void => {
    req.unpipe(body);
  };
  const cleanup = (): void => {
    req.removeListener("aborted", onAborted);
    req.removeListener("error", onError);
    req.removeListener("close", onClose);
    stopForwarding();
  };
  req.once("aborted", onAborted);
  req.once("error", onError);
  req.once("close", onClose);
  body.once("error", () => {});
  body.once("close", cleanup);
  req.pipe(body);
  return {
    body,
    signal: abort.signal,
    cancel: () => {
      if (!body.destroyed) {
        body.destroy(req.complete ? undefined : new Error("upstream request completed before upload body"));
      }
      stopForwarding();
    },
    limitExceeded: () => exceeded,
  };
}
