import { strict as assert } from "node:assert";
import { test } from "node:test";
import { hasHeadlessChrome, measureUiMarkup } from "./support/browserLayout.ts";
import { headerFixture } from "./support/headerFixture.ts";

test("phone quota fits whole accounts and keeps its step as countdowns change", async t => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const fixture = await headerFixture();
  try {
    for (const width of [360, 412, 600, 768, 1024]) {
      for (const accounts of [2, 3]) {
        await t.test(`${width}px with ${accounts} accounts`, () => {
          const m = measureUiMarkup<{
            phone: boolean;
            coarse: boolean;
            snapshots: { step: string; count: number; violations: string[] }[];
            singleWindowCount?: number;
          }>(fixture.markup(width, true) + `<i hidden data-quota-fixture="${accounts}"></i>`, width, `
            const header = document.querySelector(".workspace-head");
            let usage = header.querySelector(".header-usage");
            if (${accounts} === 3) {
              // Exercise the fitter with three entries built from the real readout markup.
              const third = usage.querySelector(".hu-provider").cloneNode(true);
              third.querySelector(".hu-name").textContent = "fixture-extra";
              usage.append(third);
            }
            const original = usage.cloneNode(true);
            const fit = () => { ${fixture.compact} };
            const inside = (inner, outer) => inner.left >= outer.left - 0.1
              && inner.right <= outer.right + 0.1 && inner.top >= outer.top - 0.1 && inner.bottom <= outer.bottom + 0.1;
            const measure = () => {
              fit();
              const violations = [];
              const entries = Array.from(usage.querySelectorAll(".hu-provider"))
                .filter(entry => entry.getClientRects().length);
              const strip = usage.getBoundingClientRect();
              if (!inside(strip, header.getBoundingClientRect())) violations.push("strip crosses header");
              entries.forEach((entry, index) => {
                const box = entry.getBoundingClientRect();
                if (!inside(box, strip)) violations.push(index + ": entry crosses strip");
                if (index && entries[index - 1].getBoundingClientRect().right > box.left + 0.1) {
                  violations.push(index + ": entries overlap");
                }
                for (const element of entry.querySelectorAll(".agent-badge,.hu-name,.hu-win,.hu-win-label,.hu-meter,.hu-pct,.hu-reset,.hu-state")) {
                  if (!element.getClientRects().length) continue;
                  const bounds = element.getBoundingClientRect();
                  if (!inside(bounds, box)) violations.push(index + ": " + element.className + " crosses entry");
                  if (element.matches(".hu-name,.hu-pct,.hu-reset,.hu-state")) {
                    const text = document.createRange();
                    text.selectNodeContents(element);
                    if (!inside(text.getBoundingClientRect(), bounds)) {
                      violations.push(index + ": " + element.className + " text is clipped");
                    }
                  }
                }
              });
              return { step: header.dataset.quotaAccounts + "/" + header.dataset.quotaDetail, count: entries.length, violations };
            };
            const updateCountdowns = (short, weekly) => {
              for (const reset of usage.querySelectorAll(".hu-reset")) {
                reset.textContent = reset.closest(".hu-win").dataset.windowKey === "5h" ? short : weekly;
              }
            };
            updateCountdowns("4h 59m", "6d 23h");
            const first = measure();
            updateCountdowns("9s", "7d");
            const shorter = measure();
            // Re-render the readout and seed a different previously selected step.
            const next = original.cloneNode(true);
            usage.replaceWith(next);
            usage = next;
            header.dataset.quotaAccounts = "0";
            header.dataset.quotaDetail = "percent";
            updateCountdowns("4h 59m", "6d 23h");
            const rerendered = measure();
            let singleWindowCount;
            if (${width} === 1024) {
              for (const weekly of usage.querySelectorAll('.hu-win[data-window-key="weekly"]')) weekly.remove();
              singleWindowCount = measure().count;
              const restored = original.cloneNode(true);
              usage.replaceWith(restored);
              usage = restored;
              updateCountdowns("4h 59m", "6d 23h");
              fit();
            }
            const result = { singleWindowCount, phone: document.documentElement.dataset.phoneHeader === "true",
              coarse: matchMedia("(pointer: coarse)").matches, snapshots: [first, shorter, rerendered] };
          `, false, 800, ["--blink-settings=primaryPointerType=2,availablePointerTypes=2"]);
          assert.ok(m.phone && m.coarse, "fixture uses the touch phone tier");
          for (const snapshot of m.snapshots) {
            assert.ok(snapshot.count > 0, "at least one account fits each fixture width");
            assert.deepEqual(snapshot.violations, [], JSON.stringify(m.snapshots));
          }
          assert.equal(m.snapshots[1]?.step, m.snapshots[0]?.step, "countdown updates keep the same step");
          assert.equal(m.snapshots[2]?.step, m.snapshots[0]?.step, "re-rendering keeps the same step");
          if (width === 1024) assert.ok((m.singleWindowCount ?? 0) >= 2, "retain multiple accounts when room allows");
        });
      }
    }
  } finally { await fixture.close(); }
});
