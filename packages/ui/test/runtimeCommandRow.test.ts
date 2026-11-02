import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { createUiSsrHarness } from "./support/ssr.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); });

async function mount(text: string, latestMessagePaging: boolean, role = "user") {
  const window = new Window({ url: "http://localhost" });
  const previous = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  const ssr = createUiSsrHarness({ ssr: { noExternal: ["markdown-to-jsx"] } });
  cleanups.push(async () => { await act(async () => root.unmount()); await ssr.close(); Object.assign(globalThis, previous); window.close(); });
  const { HistoryConversationView } = await ssr.loadModule<typeof import("../src/HistoryConversation.tsx")>("/src/HistoryConversation.tsx");
  const conversation = {
    session: { machine: "fixture", id: "sample", provider: "claude" },
    messages: [{ id: "m1", role, text, timestamp: "2026-01-01T12:00:00" }],
    latestMessagePaging, loading: false, viewportRef: { current: null }, messagePage: 0, messagePageCursors: [],
  } as unknown as import("../src/HistoryConversation.tsx").HistoryConversation;
  await act(async () => root.render(createElement(HistoryConversationView, { conversation, onJumpToLatest() {} })));
  return container as unknown as HTMLElement;
}

const CASES: Array<[string, string]> = [
  ["/compact", "Compacting context"], ["/compact focus", "Compacting context"], ["/exit", "Session restarting"],
  ["/quit", "Session quitting"], ["/effort high", "Changing effort"], ["/model", "Changing model"], ["/usage", "Showing usage"],
  ["/login", "Signing in"], ["/clear", "Clearing context"], ["/new", "Starting a new thread"],
];

for (const [text, title] of CASES) for (const [view, paging] of [["live", true], ["history", false]] as const) {
  test(`${text} renders as a system row in ${view}`, async () => {
    for (const role of ["user", "assistant"]) {
      const container = await mount(text, paging, role);
      const article = container.querySelector("article")!;
      assert.equal(article.getAttribute("aria-label"), "Runtime command");
      assert.equal(Boolean(container.querySelector(".history-bubble")), false, "no message bubble");
      assert.equal(container.querySelector(".session-notice-label")?.textContent, title);
      assert.equal(container.querySelector(".runtime-command-text")?.textContent, text, "the command text stays available to select and copy");
    }
  });
}

test("an ordinary message starting with a slash stays a bubble", async () => {
  const container = await mount("/etc/hosts is unreadable", true);
  assert.equal(Boolean(container.querySelector(".history-bubble")), true);
  assert.equal(Boolean(container.querySelector(".runtime-command-text")), false);
});
