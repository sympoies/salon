import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { Window } from "happy-dom";
import { createUiSsrHarness, renderComponent } from "./support/ssr.ts";
import { SESSION_STATUS_GROUPS, SESSION_STATUS_LABELS } from "../src/sessionStatusGroups.ts";

const ssr = createUiSsrHarness();
after(async () => ssr.close());

for (const compactHeader of [false, true]) {
  for (const count of [1, 2, "–"] as const) {
    test(`status chips expose one complete name with compactHeader=${compactHeader}, count=${count}`, async () => {
      const { SessionStatusCountButtons } = await ssr.loadModule<typeof import("../src/SessionStatusCountButtons.tsx")>("/src/SessionStatusCountButtons.tsx");
      const window = new Window();
      try {
        window.document.body.innerHTML = renderComponent(SessionStatusCountButtons, {
          counts: { working: count, waiting: count, attention: count, unknown: count, stopped: count },
          activeGroup: "unknown", offlineCountMachines: count === "–" ? [{ name: "fixture", since: 0, held: false }] : [], compactHeader, onToggle() {},
        });
        for (const group of SESSION_STATUS_GROUPS) {
          const button = window.document.querySelector(`[data-status-group="${group}"]`);
          assert.ok(button, `${group} chip exists`);
          const name = `${SESSION_STATUS_LABELS[group][0]}: ${count} ${count === 1 ? "session" : "sessions"}${count === "–" ? " (partial counts)" : ""}`;
          assert.equal(button.getAttribute("aria-label"), name, "desktop name stays unchanged");
          assert.equal(button.querySelectorAll(".sr-only").length, 0, "no duplicate full-name text node");
          assert.equal(button.querySelector("span")?.textContent, String(count), "visible count stays unchanged");
          for (const part of button.children) {
            assert.equal(part.getAttribute("aria-hidden"), "true",
              "visible count, labels and icon are excluded from accessibility so the button is read once");
          }
          assert.equal(button.querySelector(".session-status-count-label")?.textContent,
            compactHeader ? SESSION_STATUS_LABELS[group][1] : undefined, "visible label stays unchanged");
          assert.equal(button.querySelector(".session-status-count-short-label")?.textContent,
            compactHeader ? SESSION_STATUS_LABELS[group][2] : undefined, "short label stays unchanged");
        }
      } finally { await window.happyDOM.close(); }
    });
  }
}
