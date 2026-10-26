import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderNoticeSurface } from "./support/noticeSurfaces.ts";

for (const phoneFocusCounts of [true, false]) {
  test(`phone count row setting ${phoneFocusCounts}: connection notice shares the strip and dismissal restores the setting`, async () => {
    const phases: string[] = [];
    await renderNoticeSurface("dashboard", 360, {
      focused: true, restore: true, phoneFocusCounts,
      inspectClear(container, phase) {
        phases.push(phase);
        assert.equal(Boolean(container.querySelector(".slot-focus-strip")), phoneFocusCounts, phase);
        assert.equal(Boolean(container.querySelector(".slot-focus-strip .session-status-counts")), phoneFocusCounts, phase);
        assert.equal(container.querySelector(".connection-notice"), null);
        assert.equal(container.querySelector(".slot-connection-row"), null);
      },
      inspect(container, phase) {
        phases.push(phase);
        const strip = container.querySelector(".slot-focus-strip");
        assert.ok(strip?.querySelector(".connection-notice"), "notice occupies the count row");
        assert.equal(Boolean(strip.querySelector(".session-status-counts")), phoneFocusCounts);
        assert.equal(container.querySelector(".slot-connection-row"), null);
        assert.equal(container.querySelectorAll(".connection-notice").length, 1);
        assert.ok(strip.querySelector('[aria-label="Dismiss status notice"]'));
        assert.equal(strip.querySelector(".connection-notice")?.getAttribute("aria-live"), phase === "restored" ? "polite" : "assertive");
      },
    });
    assert.deepEqual(phases, ["initial", "unreachable", "restored", "dismissed"]);
  });
}

for (const focused of [true, false]) {
  test(`mac title bar ${focused ? "focused" : "overview"}: connection notice occupies the right slot`, async () => {
    await renderNoticeSurface("dashboard", 1280, {
      focused, restore: true, macTitleBar: true,
      inspectClear(container) {
        assert.equal(container.querySelector(".connection-notice"), null);
        assert.ok(container.querySelector("#mac-titlebar-counts .session-status-counts"));
      },
      inspect(container) {
        const bar = container.querySelector(".mac-titlebar");
        assert.ok(bar?.lastElementChild?.matches("#mac-titlebar-notice"));
        assert.ok(bar.lastElementChild.querySelector(".connection-notice"));
        assert.equal(bar.querySelector("#mac-titlebar-notice")?.hasAttribute("data-tauri-drag-region"), false);
        assert.ok(bar.querySelector(".mac-titlebar-space[data-tauri-drag-region]"));
        assert.equal(container.querySelector(".slot-connection-row"), null);
        assert.equal(container.querySelectorAll(".connection-notice").length, 1);
      },
    });
  });
}
