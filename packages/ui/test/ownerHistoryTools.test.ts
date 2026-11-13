import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { normalizeConversationSnapshot } from "@agent-console/shared/resources";
import { createUiSsrHarness } from "./support/ssr.ts";

const fixture = JSON.parse(readFileSync(new URL("../../shared/test/fixtures/history-owner-tool-parts-v1.json", import.meta.url), "utf8"));

test("tool disclosures render owner commands/results and otherwise use masked siblings", async () => {
  const window = new Window();
  const previous = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const container = window.document.createElement("div"); window.document.body.append(container);
  const root = createRoot(container), ssr = createUiSsrHarness();
  try {
    const { ConversationTools, conversationToolRows } = await ssr.loadModule<typeof import("../src/ConversationTools.tsx")>("/src/ConversationTools.tsx");
    for (const owner of [true, false]) {
      const messages = fixture.messages.map((row: any) => ({ ...row, role: "assistant", tool_parts: row.parts.map((part: any) =>
        Object.fromEntries(Object.entries(part).filter(([key]) => owner || !key.startsWith("owner_")))) }));
      const snapshot = normalizeConversationSnapshot({ messages });
      assert.equal(snapshot !== null, true);
      const rows = conversationToolRows(snapshot!.messages).flat();
      await act(async () => root.render(createElement(ConversationTools, { rows })));
      for (const button of container.querySelectorAll("button")) {
        if (button.getAttribute("aria-expanded") === "false") await act(async () => button.click());
      }
      assert.equal(container.querySelector(".conversation-tool-input")?.textContent, owner ? "cat /work/example/notes.txt" : "cat [path]");
      assert.equal(container.querySelector(".conversation-tool-command")?.textContent, owner ? "cat /work/example/notes.txt" : "cat [path]");
      assert.equal(container.querySelector(".conversation-tool-result")?.textContent, owner ? "Read /work/example/notes.txt" : "Read [path]");
      assert.equal(container.textContent?.includes("Already masked"), true);
      assert.equal(container.textContent?.includes("owner_future"), false);
    }
  } finally {
    await act(async () => root.unmount()); await ssr.close();
    Object.assign(globalThis, previous); window.close();
  }
});
