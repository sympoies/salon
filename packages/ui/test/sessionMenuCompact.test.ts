import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { createElement, useState } from "react";
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

const sessions = ["a", "b", "c"].map((id) => makeSession({ id, title: `Session ${id.toUpperCase()}`, model: "example-model",
  reasoning_effort: "high", context_usage: { used_tokens: 1000, window_tokens: 10000, observed_at: null, source: "codex-rollout", model: null } }));

// Every session dropdown fits its rows' harness segments (harnessCompact.ts) once
// open, including the empty-slot menu (review finding on exampleOrg/agent-console#870).
for (const view of ["empty slot", "overview card", "focused title", "focused picker"] as const) {
  test(`${view} dropdown fits every row's harness segment`, async () => {
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
      const session = view === "empty slot" ? undefined : sessions[0];
      const slot = session ? sessionKey(session) : null;
      const focused = view.startsWith("focused");
      const menuKey = view === "focused picker" ? "0:slot:nav" : "0:slot";
      function Harness() {
        const [open, setOpen] = useState<string | null>(menuKey);
        return createElement(SessionSlot, makeSessionSlotProps({
          slot, session, options: sessions, sessionNavList: sessions, focused, focusedKey: focused ? slot : null,
          sessionOrdinal: focused ? 1 : null, sessionCount: sessions.length, slotMenuKey: "0:slot",
          openSlotMenuKey: open, setOpenSlotMenuKey: setOpen, viewport: { mobile: false },
        }));
      }
      await act(async () => root.render(createElement(Harness)));
      const rows = [...container.querySelectorAll<HTMLElement>(".slot-menu-session")];
      assert.ok(rows.length >= 3, `${view} lists its sessions`);
      for (const row of rows) {
        assert.match(row.querySelector(".session-harness")?.getAttribute("data-harness-compact") ?? "", /^[0-5]$/,
          `${view} row "${row.querySelector(".slot-menu-label")?.textContent}" is fitted`);
      }
    } finally {
      await act(async () => root.unmount());
      await window.happyDOM.abort();
      Object.assign(globalThis, previous);
    }
  });
}
