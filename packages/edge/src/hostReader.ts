import { authedFetch, type FetchRedirect } from "./http.ts";

export interface HostReader {
  readonly url: string;
  readonly token: string | null;
  readonly timeoutMs?: number;
  // Endpoint path for a reader whose route is configurable (usage, Codex
  // reset); absent means the client's historical host-helper path.
  readonly path?: string;
}

interface HostReaderFetchOptions {
  readonly timeoutMs?: number;
  readonly redirect?: FetchRedirect;
  // HTTP method (default GET). The layout store is the first read-write member of
  // this pattern, so writes go through the same auth/timeout/redirect envelope.
  readonly method?: string;
  // JSON request body. When set, a `content-type: application/json` header is
  // added and the string is sent verbatim (named to make the JSON coupling
  // explicit at the call site).
  readonly jsonBody?: string;
}

interface HostReaderJsonOptions extends HostReaderFetchOptions {
  readonly maxBytes: number;
  readonly statusLabel: string;
  readonly sizeErrorMessage?: string;
  readonly emptyBody?: unknown | ((res: Response) => unknown);
  readonly ok?: (res: Response) => boolean;
}

const DEFAULT_HOST_READER_TIMEOUT_MS = 8000;

export function parseHostReader(env: Record<string, string | undefined>, prefix: string): HostReader | null {
  const url = (env[`AGENT_CONSOLE_${prefix}_URL`] ?? "").trim().replace(/\/+$/, "");
  if (!url) {
    return null;
  }
  const token = env[`AGENT_CONSOLE_${prefix}_TOKEN`] ?? "";
  return { url, token: token.length > 0 ? token : null };
}

// `AGENT_CONSOLE_<prefix>_PATH`: an absolute path of plain segments, so a
// configured route can select an endpoint on the same origin but never add a
// query, a fragment, another authority, or a parent traversal.
const READER_PATH_PATTERN = /^(?:\/[A-Za-z0-9._~-]+)+$/;

export function parseHostReaderWithPath(env: Record<string, string | undefined>, prefix: string): HostReader | null {
  const reader = parseHostReader(env, prefix);
  const name = `AGENT_CONSOLE_${prefix}_PATH`;
  const path = (env[name] ?? "").trim();
  if (!path) {
    return reader;
  }
  if (!READER_PATH_PATTERN.test(path) || path.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error(`${name} must be an absolute path of plain segments, such as /usage/v1`);
  }
  return reader ? { ...reader, path } : null;
}

async function withHostReaderResponse<T>(
  reader: HostReader,
  path: string,
  consume: (res: Response) => Promise<T> | T,
  options: HostReaderFetchOptions = {},
): Promise<T> {
  return authedFetch(`${reader.url}${path}`, consume, {
    token: reader.token,
    method: options.method,
    body: options.jsonBody,
    contentType: options.jsonBody === undefined ? undefined : "application/json",
    redirect: options.redirect,
    timeoutMs: options.timeoutMs ?? reader.timeoutMs ?? DEFAULT_HOST_READER_TIMEOUT_MS,
  });
}

export async function withHostReaderJson<T>(
  reader: HostReader,
  path: string,
  consume: (body: unknown, res: Response) => Promise<T> | T,
  options: HostReaderJsonOptions,
): Promise<T> {
  return withHostReaderResponse(
    reader,
    path,
    async (res) => {
      if (!(options.ok ?? ((r: Response) => r.ok))(res)) {
        throw new Error(`${options.statusLabel} ${res.status}`);
      }
      const text = await readCappedText(res, options.maxBytes, options.sizeErrorMessage);
      const body =
        text.length === 0 && "emptyBody" in options
          ? typeof options.emptyBody === "function"
            ? options.emptyBody(res)
            : options.emptyBody
          : JSON.parse(text);
      return await consume(body, res);
    },
    options,
  );
}

async function readCappedText(
  res: Response,
  maxBytes: number,
  errorMessage = "host reader response too large",
): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) {
    return res.text();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(errorMessage);
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}
