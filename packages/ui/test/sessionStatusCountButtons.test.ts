import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { Window } from "happy-dom";
import { createUiSsrHarness, renderComponent } from "./support/ssr.ts";
import { CLEAR_SESSION_FILTERS } from "../src/sessionFilters.ts";
import { SESSION_STATUS_GROUPS, SESSION_STATUS_LABELS } from "../src/sessionStatusGroups.ts";

const ssr = createUiSsrHarness();
after(async () => ssr.close());

for (const mode of ["list", "header"] as const) {
  for (const count of [1, 2, "–"] as const) {
    for (const partial of [false, true]) {
      test(`status chips retain complete name text in ${mode}, count=${count}, partial=${partial}`, async () => {
        const { SessionStatusCountButtons } = await ssr.loadModule<typeof import("../src/SessionStatusCountButtons.tsx")>("/src/SessionStatusCountButtons.tsx");
        const { SessionListNavigator } = await ssr.loadModule<typeof import("../src/SessionListNavigator.tsx")>("/src/SessionListNavigator.tsx");
        const window = new Window();
        const counts = { working: count, waiting: count, attention: count, unknown: count, stopped: count };
        const offlineCountMachines = partial ? [{ name: "fixture", since: 0, held: false }] : [];
        try {
          window.document.body.innerHTML = mode === "list"
            ? renderComponent(SessionListNavigator, {
              filters: { ...CLEAR_SESSION_FILTERS, statusGroup: "unknown" }, machines: [], harnesses: [],
              resultCount: 0, countsAvailable: true, statusCounts: counts, offlineCountMachines,
              mobile: true, page: 1, pageCount: 1, onPageChange() {}, onChange() {},
            })
            : renderComponent(SessionStatusCountButtons, {
              counts, activeGroup: "unknown", offlineCountMachines, onToggle() {},
            });
          for (const group of SESSION_STATUS_GROUPS) {
            const button = window.document.querySelector(`[data-status-group="${group}"]`);
            assert.ok(button, `${group} chip exists`);
            const name = `${SESSION_STATUS_LABELS[group]}: ${count} ${count === 1 ? "session" : "sessions"}${partial ? " (partial counts)" : ""}`;
            assert.equal(button.getAttribute("aria-label"), name, "desktop name stays unchanged");
            assert.equal(button.getAttribute("title"), name, "tooltip stays unchanged");
            assert.equal(button.getAttribute("aria-pressed"), String(group === "unknown"), "toggle state stays unchanged");
            const hiddenNames = button.querySelectorAll("span.sr-only");
            assert.equal(hiddenNames.length, 1, "exactly one visually hidden full-name span");
            assert.equal(hiddenNames[0]?.textContent, button.getAttribute("aria-label"), "hidden text matches the complete name");
            assert.notEqual(hiddenNames[0]?.getAttribute("aria-hidden"), "true", "full-name text remains accessible");
            assert.equal(button.querySelector("span:not(.sr-only)")?.textContent, String(count), "visible count stays unchanged");
            for (const part of button.children) {
              if (part === hiddenNames[0]) continue;
              assert.equal(part.getAttribute("aria-hidden"), "true",
                "visible count, labels and icon are excluded from accessibility so the button is read once");
            }
            assert.equal(button.querySelectorAll("span[aria-hidden='true']").length, 1, "only the count is visible text");
          }
        } finally { await window.happyDOM.close(); }
      });
    }
  }
}
