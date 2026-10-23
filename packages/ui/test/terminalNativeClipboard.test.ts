import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isMacosFilePasteCandidate, nativeClipboardPayloadToFile } from "../src/terminalNativeClipboard.ts";

test("native clipboard payload becomes a browser File for attachment upload", async () => {
  const file = nativeClipboardPayloadToFile({
    name: "SHA256SUMS-v0.1.0-macos-arm64.txt",
    contentType: "text/plain",
    dataBase64: "YWJjCg==",
  });

  assert.ok(file);
  assert.equal(file.name, "SHA256SUMS-v0.1.0-macos-arm64.txt");
  assert.equal(file.type, "text/plain");
  assert.equal(file.size, 4);
  assert.equal(await file.text(), "abc\n");
});

test("native clipboard payload rejects nameless files", () => {
  assert.equal(
    nativeClipboardPayloadToFile({
      name: "",
      contentType: "application/octet-stream",
      dataBase64: "YWJj",
    }),
    null,
  );
});

test("macOS file paste candidates do not fall through as literal file URLs", () => {
  assert.equal(isMacosFilePasteCandidate(["text/plain"], "file:///Users/Shared/Downloads/a.txt"), true);
  assert.equal(isMacosFilePasteCandidate(["public.file-url"], ""), true);
  assert.equal(isMacosFilePasteCandidate(["NSFilenamesPboardType"], ""), true);
  assert.equal(isMacosFilePasteCandidate(["text/plain"], "/Users/Shared/Downloads/a.txt"), false);
});
