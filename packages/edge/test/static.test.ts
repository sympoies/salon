import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveStaticFile, contentType } from "../src/static.ts";
import { createEdgeServer } from "../src/server.ts";
import { listenOnLoopback, makeEdgeConfig } from "./support.ts";

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "ac-static-"));
  writeFileSync(join(dir, "index.html"), "<html></html>");
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "app.js"), "console.log(1)");
  return dir;
}

test("resolveStaticFile serves an existing asset", () => {
  const dir = fixture();
  try {
    assert.equal(resolveStaticFile(dir, "/assets/app.js"), join(dir, "assets", "app.js"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveStaticFile maps / to index.html", () => {
  const dir = fixture();
  try {
    assert.equal(resolveStaticFile(dir, "/"), join(dir, "index.html"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveStaticFile falls back to index.html for unknown SPA routes", () => {
  const dir = fixture();
  try {
    assert.equal(resolveStaticFile(dir, "/dashboard"), join(dir, "index.html"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveStaticFile blocks path traversal to a real file outside the root", () => {
  // Plant a real secret as a SIBLING of uiDir so the guard, not a missing-file
  // fallback, is what prevents disclosure.
  const parent = mkdtempSync(join(tmpdir(), "ac-static-parent-"));
  const dir = join(parent, "dist");
  mkdirSync(dir);
  writeFileSync(join(dir, "index.html"), "<html></html>");
  const secret = join(parent, "secret.txt");
  writeFileSync(secret, "TOP SECRET");
  try {
    for (const attack of ["/../secret.txt", "/../../secret.txt", "/assets/../../secret.txt", "/%2e%2e/secret.txt"]) {
      const resolved = resolveStaticFile(dir, attack);
      assert.notEqual(resolved, secret, `must not resolve ${attack} to the sibling secret`);
      assert.equal(resolved, join(dir, "index.html"), `${attack} should fall back to index.html`);
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("contentType maps common extensions", () => {
  assert.match(contentType("app.js"), /javascript/);
  assert.match(contentType("index.html"), /text\/html/);
  assert.match(contentType("x.css"), /text\/css/);
  assert.match(contentType("x.svg"), /svg/);
  assert.match(contentType("x.unknown"), /octet-stream/);
});

test("edge server streams static UI files and HEAD responses", async () => {
  const dir = fixture();
  const server = createEdgeServer(makeEdgeConfig({ uiDir: dir }));
  try {
    const { base } = await listenOnLoopback(server);

    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(index.headers.get("cache-control"), "no-cache");
    assert.equal(await index.text(), "<html></html>");

    const asset = await fetch(`${base}/assets/app.js`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("content-type") ?? "", /javascript/);
    assert.equal(asset.headers.get("cache-control"), "public, max-age=3600");
    assert.equal(await asset.text(), "console.log(1)");

    const head = await fetch(`${base}/`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.match(head.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(head.headers.get("cache-control"), "no-cache");
    assert.equal(await head.text(), "");
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
