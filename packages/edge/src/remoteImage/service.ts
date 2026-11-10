import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { fetchRemoteImage } from "./fetch.ts";
import type { AllowListEntry } from "./address.ts";

export interface RemoteImageConfig {
  stateDir: string;
  allowList: readonly AllowListEntry[];
  maxBytes: number;
  timeoutMs: number;
  cacheBytes: number;
  cacheTtlMs: number;
  globalConcurrency: number;
  principalConcurrency: number;
}
export const defaults: Omit<RemoteImageConfig, "stateDir"> = { allowList: [], maxBytes: 10 * 1024 * 1024, timeoutMs: 10000, cacheBytes: 200 * 1024 * 1024, cacheTtlMs: 7 * 86400000, globalConcurrency: 16, principalConcurrency: 4 };
type Fetcher = typeof fetchRemoteImage;

export function createRemoteImageService(config: RemoteImageConfig, fetcher: Fetcher = fetchRemoteImage) {
  const counts = new Map<string, number>();
  let active = 0;
  const dir = join(config.stateDir, "remote-images");
  return async (principal: string, url: string) => {
    const file = join(dir, createHash("sha256").update(url).digest("hex"));
    try {
      const stat = statSync(file);
      if (Date.now() - stat.mtimeMs < config.cacheTtlMs) {
        const entry = JSON.parse(readFileSync(file, "utf8")) as { contentType: string; bytes: string; created: number; digest: string };
        if (["image/png", "image/jpeg", "image/gif", "image/webp"].includes(entry.contentType) && typeof entry.bytes === "string" && Number.isFinite(entry.created) && Date.now() - entry.created < config.cacheTtlMs) {
          const bytes = Buffer.from(entry.bytes, "base64");
          if (bytes.length && bytes.length <= config.maxBytes && bytes.toString("base64") === entry.bytes && createHash("sha256").update(bytes).digest("hex") === entry.digest) {
            const now = new Date(); utimesSync(file, now, now);
            return { ok: true as const, contentType: entry.contentType, bytes };
          }
        }
      }
    } catch { /* Missing or corrupt cache entries are refetched. */ }
    if (active >= config.globalConcurrency || (counts.get(principal) ?? 0) >= config.principalConcurrency) return { ok: false as const, reason: "busy" as const };
    active++; counts.set(principal, (counts.get(principal) ?? 0) + 1);
    try {
      const result = await fetcher(url, { allowList: config.allowList, maxBytes: config.maxBytes, timeoutMs: config.timeoutMs });
      if (result.ok) {
        try {
          mkdirSync(dir, { recursive: true, mode: 0o700 });
          const entry = JSON.stringify({ contentType: result.contentType, bytes: result.bytes.toString("base64"), digest: createHash("sha256").update(result.bytes).digest("hex"), created: Date.now() });
          if (Buffer.byteLength(entry) <= config.cacheBytes) {
            writeFileSync(file, entry, { mode: 0o600 });
            const entries = readdirSync(dir).filter(name => /^[a-f0-9]{64}$/.test(name)).map(name => ({ path: join(dir, name), stat: statSync(join(dir, name)) })).sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
            let size = entries.reduce((sum, item) => sum + item.stat.size, 0);
            for (const item of entries) { if (size <= config.cacheBytes) break; unlinkSync(item.path); size -= item.stat.size; }
          }
        } catch { /* Cache is optional. */ }
      }
      return result;
    } finally { active--; const remaining = counts.get(principal)! - 1; if (remaining) counts.set(principal, remaining); else counts.delete(principal); }
  };
}
