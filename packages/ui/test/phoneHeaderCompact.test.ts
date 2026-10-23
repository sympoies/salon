import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { sessionKey } from "../src/layout.ts";
import { makeSession, makeSessionSlotProps } from "./support/fixtures.ts";
import { createUiSsrHarness } from "./support/ssr.ts";

const ssr = createUiSsrHarness([{
  name: "terminal-fixture", enforce: "pre",
  resolveId(source) { return source.endsWith("TerminalPane.tsx") ? "\0terminal-fixture" : null; },
  load(id) { return id === "\0terminal-fixture" ? "export function TerminalPane() { return null; }" : null; },
}]);
after(() => ssr.close());

// The mounted phone focused header fits row 2 in the harnessCompact.ts order, so
// the page switcher never wraps to a third row (exampleOrg/agent-console#882).
for (const agent of ["claude", "codex"] as const) {
  test(`mounted phone focused header fits its ${agent} harness row`, async () => {
    const { SessionSlot } = await ssr.loadModule<typeof import("../src/SessionSlot.tsx")>("/src/SessionSlot.tsx");
    const window = new Window({ url: "http://localhost" });
    const globals = { window, document: window.document, Element: window.Element, HTMLElement: window.HTMLElement,
      MouseEvent: window.MouseEvent, KeyboardEvent: window.KeyboardEvent, Event: window.Event,
      ResizeObserver: undefined, MutationObserver: window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true };
    const previous = Object.fromEntries(Object.keys(globals).map((name) => [name, Reflect.get(globalThis, name)]));
    Object.assign(globalThis, globals);
    const container = window.document.createElement("div");
    window.document.body.append(container);
    const root = createRoot(container);
    try {
      const sessions = ["a", "b"].map((id) => makeSession({ id, agent, model: "example-model", reasoning_effort: "high",
        context_usage: { used_tokens: 1000, window_tokens: 10000, observed_at: null, source: "codex-rollout", model: null } }));
      const slot = sessionKey(sessions[0]!);
      await act(async () => root.render(createElement(SessionSlot, makeSessionSlotProps({
        slot, session: sessions[0], options: sessions, sessionNavList: sessions, focused: true, focusedKey: slot,
        sessionOrdinal: 1, sessionCount: sessions.length, viewport: { mobile: true },
      }))));
      const rowTwo = container.querySelector<HTMLElement>(".slot-focus-row-two");
      assert.ok(rowTwo, "the phone focused header renders its harness row");
      assert.match(rowTwo.getAttribute("data-harness-compact") ?? "", /^[0-5]$/, "the live header fits row 2");
    } finally {
      await act(async () => root.unmount());
      await window.happyDOM.abort();
      Object.assign(globalThis, previous);
    }
  });
}
