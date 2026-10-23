import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import type { ComponentType } from "react";
import type { Plugin } from "vite";
import type { SessionSlotProps } from "../src/SessionSlot.tsx";
import { makeSession, makeSessionSlotProps } from "./support/fixtures.ts";
import { createUiSsrHarness, renderComponent } from "./support/ssr.ts";

function terminalPaneMockPlugin(): Plugin {
  const mockId = "\0session-slot-placeholder-terminal-pane-mock";
  return {
    name: "session-slot-placeholder-terminal-pane-mock",
    enforce: "pre",
    resolveId(source, importer) {
      if (source.endsWith("TerminalPane.tsx") && importer?.includes("/src/")) {
        return mockId;
      }
      return null;
    },
    load(id) {
      return id === mockId
        ? "export function TerminalPane() { return null; }"
        : null;
    },
  };
}

const ssr = createUiSsrHarness([terminalPaneMockPlugin()]);

after(async () => ssr.close());

test("a projection-only empty slot offers creation without authoritative assignment controls", async () => {
  const module = await ssr.loadModule<{
    SessionSlot: ComponentType<SessionSlotProps>;
  }>("/src/SessionSlot.tsx");
  const html = renderComponent(module.SessionSlot, makeSessionSlotProps({
    slot: null,
    index: 1,
    session: undefined,
    options: [makeSession({ id: "candidate", title: "Candidate" })],
    slotMenuKey: "empty-1",
    openSlotMenuKey: "empty-1",
    slotAssignmentEnabled: false,
  }));

  assert.match(html, />Slot 2</);
  assert.match(html, /Session menu for slot 2/);
  assert.match(html, /role="menu"/);
  assert.doesNotMatch(html, />Candidate</);
  assert.match(html, />\+ New session/);
});
