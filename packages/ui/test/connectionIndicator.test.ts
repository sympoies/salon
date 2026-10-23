import { strict as assert } from "node:assert";
import { test } from "node:test";
import { assertNoElement } from "./support/domAssert.ts";
import { renderNoticeSurface } from "./support/noticeSurfaces.ts";

for (const width of [1280, 360]) {
  for (const focused of [false, true]) {
    test(`Dashboard lost and restored connection share the header slot (${width}px, ${focused ? "focused" : "overview"})`, async () => {
      let previousSlot: Element | null = null;
      const phases: string[] = [];
      await renderNoticeSurface("dashboard", width, { restore: true, focused, inspect(container, phase) {
        phases.push(phase);
        const notice = container.querySelector(".connection-notice");
        assert.ok(notice);
        assert.equal(notice.classList.contains(`is-${phase}`), true, notice.outerHTML);
        assert.equal(notice.getAttribute("role"), phase === "restored" ? "status" : "alert");
        const slot = notice.closest(focused ? ".terminal-slot.is-focused .slot-head" : ".session-filter-trigger-row");
        assert.ok(slot, "connection state must live in the visible header slot");
        if (previousSlot) assert.equal(slot === previousSlot, true, "restored uses the exact same header slot");
        previousSlot = slot;
        assertNoElement(container, ".workspace-head > .connection-notice-layer");
        assert.ok(notice.querySelector('[aria-label="Dismiss status notice"]'));
      } });
      assert.deepEqual(phases, ["unreachable", "restored"]);
    });
  }
}
