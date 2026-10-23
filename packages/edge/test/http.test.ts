import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { matchPath, requireParams, readJsonBody, readRawBody } from "../src/http.ts";

test("matchPath matches a static path", () => {
  assert.deepEqual(matchPath("/api/sessions", "/api/sessions"), {});
  assert.equal(matchPath("/api/sessions", "/api/other"), null);
});

test("matchPath extracts params", () => {
  const m = matchPath("/api/sessions/:machine/:id/glance", "/api/sessions/summit/hs-codex-1/glance");
  assert.deepEqual(m, { machine: "summit", id: "hs-codex-1" });
});

test("matchPath returns null on segment-count mismatch", () => {
  assert.equal(matchPath("/api/sessions/:machine", "/api/sessions/a/b"), null);
  assert.equal(matchPath("/api/sessions/:machine/:id", "/api/sessions/a"), null);
});

test("matchPath extracts params for the tmux buffer route", () => {
  const m = matchPath("/api/sessions/:machine/:id/buffer", "/api/sessions/summit/hs-claude-1/buffer");
  assert.deepEqual(m, { machine: "summit", id: "hs-claude-1" });
});

test("matchPath url-decodes params", () => {
  const m = matchPath("/api/x/:v", "/api/x/a%2Fb");
  assert.deepEqual(m, { v: "a/b" });
});

test("matchPath does not match empty param segments", () => {
  assert.equal(matchPath("/api/sessions/:machine", "/api/sessions/"), null);
});

test("requireParams narrows a full match and rejects gaps", () => {
  assert.deepEqual(requireParams({ machine: "m", id: "x" }, ["machine", "id"]), { machine: "m", id: "x" });
  assert.equal(requireParams(null, ["machine"]), null);
  assert.equal(requireParams({ machine: "m" }, ["machine", "id"]), null);
});

function bodyReq(text: string): IncomingMessage {
  return Readable.from([Buffer.from(text, "utf8")]) as unknown as IncomingMessage;
}

test("readJsonBody parses JSON and treats empty as undefined", async () => {
  assert.deepEqual(await readJsonBody(bodyReq('{"a":1}')), { a: 1 });
  assert.equal(await readJsonBody(bodyReq("")), undefined);
});

test("readJsonBody rejects malformed JSON", async () => {
  await assert.rejects(() => readJsonBody(bodyReq("{not json")));
});

test("readJsonBody enforces the size limit (DoS guard)", async () => {
  const big = "x".repeat(200);
  await assert.rejects(() => readJsonBody(bodyReq(big), 64), /too large/);
});

test("readRawBody enforces the size limit (attachment DoS guard)", async () => {
  await assert.rejects(() => readRawBody(bodyReq("x".repeat(200)), 64), /too large/);
});

test("readRawBody returns the raw bytes when under the limit", async () => {
  const buf = await readRawBody(bodyReq("hello"), 64);
  assert.equal(buf.toString("utf8"), "hello");
});
