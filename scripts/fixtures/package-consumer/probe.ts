import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { startEdge } from "@agent-console/edge/start";
import type { EdgeExtension } from "@agent-console/edge/extensions";
import { normalizeOrder } from "@agent-console/shared/api";
import { normalizeConversationImages, type ConversationImage } from "@agent-console/shared/conversation-images";
import { normalizeRefusedOutboxAction, type RefusedOutboxAction } from "@agent-console/shared/shared-outbox";

assert.deepEqual(normalizeOrder({ order: ["a", "a", ""] }), ["a"]);
const refusedAction: RefusedOutboxAction = {
  operation: "discard_refused", expected_session_incarnation: "fixture-incarnation", base_revision: 1,
};
assert.deepEqual(normalizeRefusedOutboxAction(refusedAction), refusedAction);
assert.equal(normalizeRefusedOutboxAction({ ...refusedAction, base_revision: 0 }), null);
assert.equal(normalizeRefusedOutboxAction({ ...refusedAction, operation: "cancel" }), null);
const image: ConversationImage = { id: `${"a".repeat(16)}.0.0.${"b".repeat(32)}` };
assert.deepEqual(normalizeConversationImages([{ ...image, path: "/workspace/image.png" }, { id: "https://example.invalid/image.png" }]), [image]);
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const imageCredentials: Array<string | undefined> = [];
const upstream = createServer((request, response) => {
  if (request.url?.includes("/images/")) {
    imageCredentials.push(request.headers.authorization);
    response.writeHead(200, { "content-type": "image/png", "set-cookie": "upstream=fixture" });
    response.end(png);
  } else {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ sessions: [] }));
  }
});
upstream.listen(0, "127.0.0.1");
await once(upstream, "listening");
const upstreamAddress = upstream.address();
assert.ok(upstreamAddress && typeof upstreamAddress !== "string");
const extension: EdgeExtension = {
  id: "fixture",
  routes: [{ id: "ping", pattern: "/api/ext/fixture/ping", methods: ["GET"], permission: "debug",
    handle: context => context.sendJson(200, { fixture: true }) }],
};
const server = startEdge({
  AGENT_CONSOLE_EDGE_HOST: "127.0.0.1", AGENT_CONSOLE_EDGE_PORT: "0",
  AGENT_CONSOLE_MACHINES: JSON.stringify([{ name: "fixture", url: `http://127.0.0.1:${upstreamAddress.port}`, token: "fixture-daemon-token" }]),
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
  const imageUrl = `${base}/api/history/sessions/fixture/history/images/${image.id}`;
  assert.equal((await fetch(imageUrl)).status, 401);
  assert.equal(imageCredentials.length, 0, "unauthenticated image reads never contact upstream");
  const imageResponse = await fetch(imageUrl, { headers });
  assert.equal(imageResponse.status, 200);
  assert.equal(imageResponse.headers.get("content-type"), "image/png");
  assert.equal(imageResponse.headers.get("cache-control"), "private, no-store");
  assert.equal(imageResponse.headers.get("set-cookie"), null);
  assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), png);
  assert.deepEqual(imageCredentials, ["Bearer fixture-daemon-token"]);
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
  console.log("packed edge and generic UI: PASS (auth, extension route, shared runtime/refused action, authenticated image bytes, page, JS, CSS, fonts)");
} finally {
  server.closeAllConnections();
  upstream.closeAllConnections();
  await Promise.all([server, upstream].map(server => new Promise<void>((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()))));
}
