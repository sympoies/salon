import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import type { ComponentType } from "react";
import type { Plugin } from "vite";
import type { SessionSlotProps } from "../src/SessionSlot.tsx";
import { makeSession, makeSessionSlotProps } from "./support/fixtures.ts";
import { hasHeadlessChrome, measureUiMarkup } from "./support/browserLayout.ts";
import { uiSource } from "./support/source.ts";
import { createUiSsrHarness, renderComponent } from "./support/ssr.ts";

const terminalFixture: Plugin = {
  name: "empty-header-terminal-fixture", enforce: "pre",
  resolveId(id, importer) {
    if (id.endsWith("TerminalPane.tsx") && importer?.includes("/src/")) return "\0empty-header-terminal";
  },
  load(id) {
    if (id === "\0empty-header-terminal") return "export function TerminalPane() { return null; }";
  },
};
const ssr = createUiSsrHarness([terminalFixture]);
after(async () => ssr.close());

interface HeaderMeasurement {
  readonly height: number;
  readonly contentOffset: number;
  readonly contentTop: number;
  readonly top: number;
  readonly rows: number;
  readonly rowHeights: number[];
}

for (const count of [4, 6]) {
  test(`1440px ${count}-slot grid aligns empty and occupied two-row headers`, async t => {
    if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
    const { SessionSlot } = await ssr.loadModule<{ SessionSlot: ComponentType<SessionSlotProps> }>("/src/SessionSlot.tsx");
    const slots = Array.from({ length: count }, (_, index) => {
      const occupied = index % 3 === 0 || index === count - 1;
      const session = occupied ? makeSession({
        id: `slot-${index}`, title: `Session ${index + 1}`, model: "example-model",
        status: index === count - 1 ? "stopped" : "running", resumable: true,
        provider_resume: { provider: "codex", session_id: `history-${index}` },
      }) : undefined;
      return renderComponent(SessionSlot, makeSessionSlotProps({
        index, slot: session ? `${session.machine}/${session.id}` : null, session,
        options: session ? [session] : [], viewport: { mobile: false },
      }));
    }).join("");
    const result = measureUiMarkup<{ headers: HeaderMeasurement[] }>(
      `<style>${uiSource("sessionCardRows.css")}</style><ol class="session-workspace desktop mode-${count} slots-${count}" style="height:600px">${slots}</ol>`,
      1440,
      `const result = {headers:[...document.querySelectorAll('.terminal-slot')].map(slot => {
        const header = slot.querySelector('.slot-head');
        const content = slot.querySelector('.slot-terminal-wrap, .slot-session-state, .slot-empty');
        const rect = slot.getBoundingClientRect();
        return {height:header.getBoundingClientRect().height, top:rect.top,
          contentOffset:content.getBoundingClientRect().top-rect.top,
          contentTop:content.getBoundingClientRect().top,
          rows:header.querySelectorAll('.slot-session-card-row-one, .slot-session-card-row-two').length,
          rowHeights:[...header.querySelectorAll('.slot-session-card-row-one, .slot-session-card-row-two')]
            .map(row => row.getBoundingClientRect().height)};
      })};`,
    );
    assert.equal(result.headers.length, count);
    assert.equal(new Set(result.headers.map(header => header.height)).size, 1,
      `every header reserves equal height: ${JSON.stringify(result.headers)}`);
    assert.equal(new Set(result.headers.map(header => header.contentOffset)).size, 1,
      "content begins at the same offset within every slot");
    assert.deepEqual(result.headers.map(header => header.rows), Array(count).fill(2));
    for (const header of result.headers) {
      assert.ok(header.rowHeights.every(height => height > 0), "both rows reserve visible height, including empty rows");
      assert.ok(header.height >= header.rowHeights.reduce((sum, height) => sum + height, 0),
        "the header contains both reserved rows");
    }
    const rows = new Map<number, number[]>();
    for (const header of result.headers) rows.set(header.top, [...(rows.get(header.top) ?? []), header.contentTop]);
    for (const tops of rows.values()) assert.equal(new Set(tops).size, 1, "content aligns across each grid row");
  });
}

test("phone empty slot retains its existing single-row header and selection placeholder", async () => {
  const { SessionSlot } = await ssr.loadModule<{ SessionSlot: ComponentType<SessionSlotProps> }>("/src/SessionSlot.tsx");
  const html = renderComponent(SessionSlot, makeSessionSlotProps({
    slot: null, session: undefined, index: 1, viewport: { mobile: true },
  }));
  assert.doesNotMatch(html, /slot-session-card-row-(?:one|two)/);
  assert.match(html, /Session menu for slot 2/);
  assert.match(html, /Select a session/);
});
