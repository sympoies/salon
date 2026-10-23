import { createReadStream, existsSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { join, normalize, extname } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

export function contentType(name: string): string {
  return TYPES[extname(name).toLowerCase()] ?? "application/octet-stream";
}

// Resolve a request path to a file inside uiDir. Directory / unknown routes fall
// back to index.html (SPA). Any path that would escape uiDir is contained and
// falls back to index.html instead — never resolving outside the served root.
export function resolveStaticFile(uiDir: string, urlPath: string): string {
  const index = join(uiDir, "index.html");
  const clean = normalize(decodeURIComponentSafe(urlPath.split("?")[0] ?? "/"));
  const candidate = normalize(join(uiDir, clean));
  const root = normalize(uiDir);
  if (candidate !== root && !candidate.startsWith(root + "/")) {
    return index; // traversal attempt -> contained
  }
  if (existsSync(candidate) && statSync(candidate).isFile()) {
    return candidate;
  }
  return index;
}

export function serveStatic(res: ServerResponse, uiDir: string, urlPath: string, headOnly: boolean): void {
  const file = resolveStaticFile(uiDir, urlPath);
  const isHtml = file.endsWith(".html");
  res.writeHead(200, {
    "content-type": contentType(file),
    "cache-control": isHtml ? "no-cache" : "public, max-age=3600",
  });
  if (headOnly) {
    res.end();
    return;
  }
  const stream = createReadStream(file);
  stream.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(404, { "content-type": "text/plain" });
    }
    res.end("not found");
  });
  stream.pipe(res);
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
