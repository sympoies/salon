import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { createUiSsrHarness } from "./support/ssr.ts";

const cases = [
  { name: "Bash", input: '{"command":"pwd","description":"Print working directory"}', primary: "pwd", description: "Print working directory" },
  { name: "exec_command", input: '{"cmd":"printf example","yield_time_ms":1000}', primary: "printf example" },
  { name: "Read", input: '{"file_path":"/work/example/notes.txt","offset":10}', primary: "/work/example/notes.txt" },
  { name: "read_file", input: '{"path":"/work/example/notes.txt"}', primary: "/work/example/notes.txt" },
  { name: "search", input: '{"query":"example","limit":3}', primary: "query: example; limit: 3" },
  { name: "Bash", input: '{"command":"cat [path]","description":"Read [path]"}', primary: "cat [path]", description: "Read [path]" },
  { name: "Bash", input: "cat [path]", primary: "cat [path]" },
];

test("tool titles and expanded input use the selected authorized text readably", async t => {
  const window = new Window();
  const previous = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const container = window.document.createElement("div"); window.document.body.append(container);
  const root = createRoot(container), ssr = createUiSsrHarness();
  try {
    const { ConversationTools } = await ssr.loadModule<typeof import("../src/ConversationTools.tsx")>("/src/ConversationTools.tsx");
    for (const owner of [false, true]) for (const [index, fixture] of cases.entries()) {
      await t.test(`${fixture.name} ${index} ${owner ? "owner" : "shared"}`, async () => {
        const call = { kind: "tool_call" as const, id: `call-${index}-${owner}`, name: fixture.name,
          input_summary: owner ? "[masked]" : fixture.input, ...(owner ? { owner_input_summary: fixture.input } : {}) };
        const result = { kind: "tool_result" as const, id: "result", summary: "Example output" };
        await act(async () => root.render(createElement(ConversationTools, { rows: [{ call, result }] })));
        const button = container.querySelector("button")!;
        if (button.getAttribute("aria-expanded") === "true") await act(async () => button.click());
        assert.equal(container.querySelector("strong")?.textContent, fixture.name);
        assert.equal(container.querySelector(".conversation-tool-input")?.textContent, fixture.primary);
        await act(async () => button.click());
        assert.equal(container.querySelector(".conversation-tool-command")?.textContent, fixture.primary);
        assert.equal(container.querySelector(".conversation-tool-description")?.textContent ?? undefined, fixture.description);
        assert.equal(container.querySelector(".conversation-tool-result")?.textContent, "Example output");
        assert.equal(container.textContent?.includes("[masked]"), false);
        if (fixture.input.includes("[path]")) assert.equal(container.textContent?.includes("/work/example"), false);
      });
    }
  } finally {
    await act(async () => root.unmount()); await ssr.close();
    Object.assign(globalThis, previous); window.close();
  }
});
