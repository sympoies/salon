import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEdgeServer } from "../src/server.ts";
import { listenOnLoopback, makeEdgeConfig } from "./support.ts";

test("configured Android association is anonymous JSON with no redirect or auth side effect", async () => {
  const androidAppLinks = [{ packageName: "test.example.shell", sha256CertFingerprints: [Array(32).fill("AB").join(":")] }];
  const edge = createEdgeServer({ ...makeEdgeConfig(), androidAppLinks });
  try {
    const { base } = await listenOnLoopback(edge);
    const response = await fetch(`${base}/.well-known/assetlinks.json`, { redirect: "manual" });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
    assert.equal(response.headers.get("location"), null); assert.equal(response.headers.get("set-cookie"), null);
    assert.deepEqual(await response.json(), [{ relation: ["delegate_permission/common.handle_all_urls"],
      target: { namespace: "android_app", package_name: androidAppLinks[0]!.packageName,
        sha256_cert_fingerprints: androidAppLinks[0]!.sha256CertFingerprints } }]);
    const head = await fetch(`${base}/.well-known/assetlinks.json`, { method: "HEAD" });
    assert.equal(head.status, 200); assert.equal(head.headers.get("cache-control"), "no-store"); assert.equal(await head.text(), "");
  } finally { await new Promise<void>(resolve => edge.close(() => resolve())); }
});

test("absent Android association is 404 rather than the SPA or authentication", async () => {
  const edge = createEdgeServer(makeEdgeConfig());
  try {
    const { base } = await listenOnLoopback(edge);
    const response = await fetch(`${base}/.well-known/assetlinks.json`);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("cache-control"), "no-store");
  } finally { await new Promise<void>(resolve => edge.close(() => resolve())); }
});

for (const suffix of ["/extra", ".backup"]) test(`configured Android association refuses the alias ${suffix}`, async () => {
  const edge = createEdgeServer({ ...makeEdgeConfig(), androidAppLinks: [
    { packageName: "test.example.shell", sha256CertFingerprints: [Array(32).fill("AB").join(":")] },
  ] });
  try {
    const { base } = await listenOnLoopback(edge);
    const response = await fetch(`${base}/.well-known/assetlinks.json${suffix}`, { redirect: "manual" });
    assert.equal(response.status, 404, "association aliases must not serve the document or the SPA");
  } finally { await new Promise<void>(resolve => edge.close(() => resolve())); }
});

test("configured Android association refuses POST without an authentication side effect", async () => {
  const edge = createEdgeServer({ ...makeEdgeConfig(), androidAppLinks: [
    { packageName: "test.example.shell", sha256CertFingerprints: [Array(32).fill("AB").join(":")] },
  ] });
  try {
    const { base } = await listenOnLoopback(edge);
    const response = await fetch(`${base}/.well-known/assetlinks.json`, { method: "POST", redirect: "manual" });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(response.headers.get("location"), null);
  } finally { await new Promise<void>(resolve => edge.close(() => resolve())); }
});

test("invalid Android signing identity is refused at startup with a fixed error", () => {
  for (const app of [
    { packageName: "not a package", sha256CertFingerprints: [Array(32).fill("AB").join(":")] },
    { packageName: "test.example.shell", sha256CertFingerprints: [] },
    { packageName: "test.example.shell", sha256CertFingerprints: ["malformed-signing-fingerprint"] },
  ]) assert.throws(() => createEdgeServer({ ...makeEdgeConfig(), androidAppLinks: [app] }),
    { message: "Invalid Android app association configuration." });
});


test("other well-known paths retain static file and SPA fallback behavior", async () => {
  const dir = mkdtempSync(join(tmpdir(), "association-static-"));
  mkdirSync(join(dir, ".well-known"));
  writeFileSync(join(dir, "index.html"), "fallback");
  writeFileSync(join(dir, ".well-known", "other.txt"), "other document");
  const edge = createEdgeServer({ ...makeEdgeConfig(), uiDir: dir });
  try {
    const { base } = await listenOnLoopback(edge);
    const file = await fetch(`${base}/.well-known/other.txt`);
    assert.equal(file.status, 200); assert.equal(await file.text(), "other document");
    const fallback = await fetch(`${base}/.well-known/unknown`);
    assert.equal(fallback.status, 200); assert.equal(await fallback.text(), "fallback");
  } finally { await new Promise<void>(resolve => edge.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});
