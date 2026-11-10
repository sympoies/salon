import * as http from "node:http";
import * as https from "node:https";
import { lookup } from "node:dns/promises";
import { decideTarget, parseRemoteImageUrl, type AllowListEntry } from "./address.ts";

type Reason = "invalid-url" | "blocked-address" | "too-many-redirects" | "upstream-status" | "too-large" | "timeout" | "not-image" | "network";
type Result = { ok: true; contentType: string; bytes: Buffer } | { ok: false; reason: Reason };
type Connector = (options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) => http.ClientRequest;
type Options = {
  allowList?: readonly AllowListEntry[];
  resolver?: (host: string) => Promise<readonly string[]>;
  maxBytes?: number;
  timeoutMs?: number;
  /** Test-only transport injection; production configuration does not expose this. */
  connector?: Connector;
};

const fail = (reason: Reason): Result => ({ ok: false, reason });
const resolve = async (host: string): Promise<string[]> => (await lookup(host, { all: true })).map((item) => item.address);

export async function fetchRemoteImage(rawUrl: string, options: Options = {}): Promise<Result> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  const deadline = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true }));
  let current = rawUrl;
  try {
    for (let redirects = 0; ; redirects++) {
      let target: ReturnType<typeof parseRemoteImageUrl>;
      try { target = parseRemoteImageUrl(current); } catch { return fail("invalid-url"); }
      const addresses = target.isIpLiteral ? [target.host] : await Promise.race([(options.resolver ?? resolve)(target.host), deadline]);
      const decision = decideTarget(target, addresses, options.allowList ?? []);
      if (!decision.allowed || !decision.address) return fail("blocked-address");
      const address = decision.address;
      const url = new URL(current);
      const connector = options.connector ?? (target.scheme === "https" ? https.request : http.request);
      const response = await Promise.race([new Promise<http.IncomingMessage>((resolveResponse, reject) => {
        const request = connector({
          protocol: url.protocol, hostname: target.host, port: target.port,
          path: `${url.pathname}${url.search}`, method: "GET", signal: controller.signal,
          headers: { "User-Agent": "Salon-Remote-Image/1.0", Accept: "image/*" },
          servername: target.host,
          lookup: (_host, _options, callback) => {
            const family = address.includes(":") ? 6 : 4;
            if (typeof _options === "object" && _options.all) callback(null, [{ address, family }]);
            else callback(null, address, family);
          },
        } as https.RequestOptions, resolveResponse);
        request.on("error", reject);
        request.end();
      }), deadline]);
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.destroy();
        if (redirects >= 3) return fail("too-many-redirects");
        try { current = new URL(response.headers.location, url).href; } catch { return fail("invalid-url"); }
        continue;
      }
      if (status < 200 || status >= 300) { response.destroy(); return fail("upstream-status"); }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > (options.maxBytes ?? 10 * 1024 * 1024)) { response.destroy(); return fail("too-large"); }
        chunks.push(bytes);
      }
      const bytes = Buffer.concat(chunks);
      let contentType: string | undefined;
      if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) contentType = "image/png";
      else if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) contentType = "image/jpeg";
      else if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) contentType = "image/gif";
      else if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") contentType = "image/webp";
      return contentType ? { ok: true, contentType, bytes } : fail("not-image");
    }
  } catch {
    return fail(controller.signal.aborted ? "timeout" : "network");
  } finally { clearTimeout(timer); }
}
