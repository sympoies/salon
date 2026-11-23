import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { createUiSsrHarness } from "./support/ssr.ts";

test("tool status labels agree for single cards and groups", async () => {
  const window = new Window();
  const previous = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const container = window.document.createElement("div"); window.document.body.append(container);
  const root = createRoot(container), ssr = createUiSsrHarness();
  try {
    const { ConversationTools, ConversationToolGroup } = await ssr.loadModule<typeof import("../src/ConversationTools.tsx")>("/src/ConversationTools.tsx");
    const row = (id: string, status: "ok" | "error") => ({ call: { kind: "tool_call" as const, id, name: "Read", status } });
    const ok = row("ok", "ok"), error = row("error", "error");
    await act(async () => root.render(createElement("div", null,
      createElement(ConversationTools, { rows: [ok, error] }),
      ...[[ok, error], [error, error, error]].map((rows, index) => createElement(ConversationToolGroup, {
        key: index, rows, timestamps: [], growing: false, renderSummary: toggle => toggle, children: null,
      }))
    )));
    assert.deepEqual([...container.querySelectorAll(".conversation-tool-status")].map(el => el.textContent), ["OK", "Error"]);
    const groups = [...container.querySelectorAll(".conversation-tool-group-toggle")];
    assert.deepEqual(groups.map(el => el.querySelector(".conversation-tool-group-error")?.textContent), ["1 Error", "3 Errors"]);
    assert.match(groups[0]!.getAttribute("aria-label")!, /1 Error$/);
    assert.match(groups[1]!.getAttribute("aria-label")!, /3 Errors$/);
  } finally {
    await act(async () => root.unmount()); await ssr.close();
    Object.assign(globalThis, previous); window.close();
  }
});
