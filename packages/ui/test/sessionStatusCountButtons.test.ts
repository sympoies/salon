import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { Window } from "happy-dom";
import { createUiSsrHarness, renderComponent } from "./support/ssr.ts";
import { SESSION_STATUS_GROUPS, SESSION_STATUS_LABELS } from "../src/sessionStatusGroups.ts";

const ssr = createUiSsrHarness();
after(async () => ssr.close());

for (const compactHeader of [false, true]) {
  for (const count of [1, 2, "–"] as const) {
    test(`status chips retain complete hidden names with compactHeader=${compactHeader}, count=${count}`, async () => {
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
          assert.equal(button.querySelector(".sr-only")?.textContent, name,
            "name text remains available when responsive CSS hides visible status labels");
          const visible = button.cloneNode(true) as Element;
          visible.querySelectorAll(".sr-only").forEach(node => node.remove());
          assert.equal(visible.querySelector("span")?.textContent, String(count), "visible count stays unchanged");
        }
      } finally { await window.happyDOM.close(); }
    });
  }
}
