import { strict as assert } from "node:assert";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo, Server as NetServer } from "node:net";
import type { EdgeConfig } from "../src/config.ts";

export interface JsonResult {
  readonly status: number;
  readonly body: unknown;
}

export function makeEdgeConfig(overrides: Partial<EdgeConfig> = {}): EdgeConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    clientToken: "",
    principals: [],
    multiUser: false,
    accessDbPath: null,
    openAccess: true,
    machines: [],
    speechProviders: [],
    uiDir: "/nonexistent-ui",
    secureCookie: false,
    maxAttachmentBytes: 1024 * 1024 * 1024,
    usage: null,
    codexReset: null,
    claudeReset: null,
    layout: null,
    titleSummarizer: null,
    ...overrides,
  };
}

export async function listenOnLoopback(server: NetServer): Promise<{ base: string; port: number }> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, port };
}

export function cookieFrom(res: Response): string {
  const setCookie = res.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0] ?? "";
  assert.ok(cookie, "response did not include a session cookie");
  return cookie;
}

export async function loginCookie(base: string, token = "client-secret"): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  assert.equal(res.status, 200);
  return cookieFrom(res);
}

export function jsonReader(handler: (url: URL) => JsonResult | null): HttpServer {
  return createServer((req, res) => {
    const result = handler(new URL(req.url ?? "/", "http://x"));
    if (result) {
      res.writeHead(result.status, { "content-type": "application/json" });
      res.end(JSON.stringify(result.body));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
}

export function closeServers(...servers: NetServer[]): void {
  for (const server of servers) {
    server.close();
  }
}
