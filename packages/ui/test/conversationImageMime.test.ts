import { strict as assert } from "node:assert";
import test from "node:test";
import { Window } from "happy-dom";
import { fetchConversationImage } from "../src/conversationImageData.ts";
import { saveConversationImage } from "../src/saveConversationImage.ts";

test("native HTTP image reads carry the validated MIME and original bytes into Android save", async (t) => {
  const window = new Window({ url: "http://tauri.localhost" });
  const previousWindow = globalThis.window;
  Object.assign(globalThis, { window });
  t.after(() => { globalThis.window = previousWindow; window.close(); });
  Object.defineProperty(window.navigator, "userAgent", { value: "Android", configurable: true });
  window.localStorage.setItem("ac:server-url", "http://localhost");

  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  let read = false;
  // Exercise the real HTTP plugin's Response construction. Only the native IPC
  // transport is substituted; no browser fetch or hand-built typed Blob masks
  // the difference between public response headers and internal Blob MIME.
  Object.assign(window, { __TAURI_INTERNALS__: {
    async invoke(command: string) {
      if (command === "plugin:http|fetch") return 1;
      if (command === "plugin:http|fetch_send") return {
        status: 200, statusText: "OK", url: "http://localhost/image", rid: 2,
        headers: [["content-type", "image/png; charset=utf-8"],
          ["content-disposition", "inline; filename*=UTF-8''original%20plot.png"]],
      };
      if (command === "plugin:http|fetch_read_body") {
        if (read) return [1];
        read = true;
        return [...bytes, 0];
      }
      assert.fail(`Unexpected native command: ${command}`);
    },
  } });

  let received: unknown;
  Object.assign(window, { agentConsoleAndroidImageSave: {
    save(id: string, name: string, mime: string, base64: string) {
      received = { name, mime, bytes: new Uint8Array(Buffer.from(base64, "base64")) };
      window.dispatchEvent(new window.CustomEvent("agent-console-image-save", { detail: { id, status: "cancelled" } }));
    },
  } });
  const image = await fetchConversationImage("fixture", "history",
    `${"a".repeat(16)}.0.0.${"b".repeat(32)}`, new AbortController().signal);
  assert.ok(image.state === "ready");
  t.after(() => URL.revokeObjectURL(image.url));
  await saveConversationImage(image.blob, image.filename, image.url);
  assert.deepEqual(received, { name: "original plot.png", mime: "image/png", bytes });
});

test("conversation images keep their bytes when Blob.slice treats an undefined end as 0", async (t) => {
  // Models an older engine whose Blob.slice reads an undefined end as 0.
  const nativeSlice = Blob.prototype.slice;
  Blob.prototype.slice = function (this: Blob, start?: number, end?: number, type?: string) {
    return nativeSlice.call(this, start, end === undefined ? 0 : end, type);
  };
  t.after(() => { Blob.prototype.slice = nativeSlice; });
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const original = globalThis.fetch;
  const window = new Window({ url: "http://localhost" });
  const previousWindow = globalThis.window;
  Object.assign(globalThis, { window });
  window.localStorage.setItem("ac:server-url", "http://localhost");
  globalThis.fetch = (async () => new Response(bytes, { headers: { "content-type": "image/png" } })) as typeof fetch;
  t.after(() => { globalThis.fetch = original; globalThis.window = previousWindow; window.close(); });
  const image = await fetchConversationImage("fixture", "history",
    `${"a".repeat(16)}.0.0.${"b".repeat(32)}`, new AbortController().signal);
  assert.ok(image.state === "ready");
  t.after(() => URL.revokeObjectURL(image.url));
  assert.equal(image.blob.type, "image/png");
  assert.deepEqual(new Uint8Array(await image.blob.arrayBuffer()), bytes);
});
