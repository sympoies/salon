import assert from "node:assert/strict";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { startEdge } from "@agent-console/edge/start";
import type { EdgeExtension } from "@agent-console/edge/extensions";
import { normalizeOrder } from "@agent-console/shared/api";

assert.deepEqual(normalizeOrder({ order: ["a", "a", ""] }), ["a"]);
const extension: EdgeExtension = {
  id: "fixture",
  routes: [{ id: "ping", pattern: "/api/ext/fixture/ping", methods: ["GET"], permission: "debug",
    handle: context => context.sendJson(200, { fixture: true }) }],
};
const server = startEdge({
  AGENT_CONSOLE_EDGE_HOST: "127.0.0.1", AGENT_CONSOLE_EDGE_PORT: "0",
  AGENT_CONSOLE_TOKEN: "fixture-token", AGENT_CONSOLE_UI_DIR: fileURLToPath(new URL("./dist", import.meta.url)),
}, { extensions: [extension] });
try {
  if (!server.listening) await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { authorization: "Bearer fixture-token" };
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/api/sessions`)).status, 401);
  assert.equal((await fetch(`${base}/api/sessions`, { headers })).status, 200);
  assert.equal((await fetch(`${base}/api/ext/fixture/ping`)).status, 401);
  const ping = await fetch(`${base}/api/ext/fixture/ping`, { headers });
  assert.equal(ping.status, 200);
  assert.deepEqual(await ping.json(), { fixture: true });
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /^text\/html\b/);
  const html = await page.text();
  const assets = [...html.matchAll(/(?:src|href)="\.\/([^"?]+\.(?:js|css|png|svg))"/g)].map(match => match[1]!);
  assert.ok(assets.some(path => path.endsWith(".js")));
  assert.ok(assets.some(path => path.endsWith(".css")));
  let fontsFetched = 0;
  for (const path of assets) {
    const response = await fetch(`${base}/${path}`);
    assert.equal(response.status, 200, path);
    const mime = path.endsWith(".js") ? /^text\/javascript\b/
      : path.endsWith(".css") ? /^text\/css\b/ : path.endsWith(".png") ? /^image\/png\b/ : /^image\/svg\+xml\b/;
    assert.match(response.headers.get("content-type") ?? "", mime,
      `${path} must be an asset, not the SPA fallback`);
    if (path.endsWith(".css")) {
      const css = await response.text();
      const fonts = [...css.matchAll(/url\(["']?([^)'" ]+\.woff2)["']?\)/g)].map(match => match[1]!);
      for (const font of fonts) {
        const response = await fetch(new URL(font, `${base}/${path}`));
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type") ?? "", /^font\/woff2\b/);
        assert.ok((await response.arrayBuffer()).byteLength > 0);
        fontsFetched += 1;
      }
    }
  }
  assert.ok(fontsFetched >= 2, "both font assets survive packing and composition");
  console.log("packed edge and generic UI: PASS (auth, extension route, shared runtime, page, JS, CSS, fonts)");
} finally {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
