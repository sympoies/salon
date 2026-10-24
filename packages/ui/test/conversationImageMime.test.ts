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
