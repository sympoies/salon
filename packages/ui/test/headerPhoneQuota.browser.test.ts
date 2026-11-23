import { strict as assert } from "node:assert";
import { test } from "node:test";
import { hasHeadlessChrome, measureUiMarkup } from "./support/browserLayout.ts";
import { headerFixture } from "./support/headerFixture.ts";

const measureQuota = `
const inside = (inner, outer) => inner.left >= outer.left - 0.1
  && inner.right <= outer.right + 0.1 && inner.top >= outer.top - 0.1 && inner.bottom <= outer.bottom + 0.1;
const overlaps = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.1
  && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.1;
const measure = () => {
  fit();
  const violations = [];
  const entries = Array.from(usage.querySelectorAll(".hu-provider"))
    .filter(entry => entry.getClientRects().length);
  const strip = usage.getBoundingClientRect();
  if (entries.length && !inside(strip, header.getBoundingClientRect())) violations.push("strip crosses header");
  entries.forEach((entry, index) => {
    const box = entry.getBoundingClientRect();
    const badge = entry.querySelector(".agent-badge")?.getBoundingClientRect();
    if (!badge?.width || !badge.height) violations.push(index + ": provider badge is hidden");
    if (!inside(box, strip)) violations.push(index + ": entry crosses strip");
    if (index && entries[index - 1].getBoundingClientRect().right > box.left + 0.1) {
      violations.push(index + ": entries overlap");
    }
    for (const group of [entry, ...entry.querySelectorAll(".hu-win")]) {
      const children = [...group.children].filter(child => child.getClientRects().length);
      for (const [i, child] of children.entries()) {
        const rect = child.getBoundingClientRect();
        if (children.slice(i + 1).some(other => overlaps(rect, other.getBoundingClientRect()))) {
          violations.push(index + ": " + child.className + " overlaps a sibling");
        }
      }
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
  const windows = [...(entries[0]?.querySelectorAll(".hu-win") ?? [])]
    .filter(window => window.getClientRects().length)
    .map(window => ({
      key: window.dataset.windowKey,
      label: Boolean(window.querySelector(".hu-win-label").getClientRects().length),
      meter: Boolean(window.querySelector(".hu-meter").getClientRects().length),
      percent: window.querySelector(".hu-pct").textContent,
    }));
  return { step: header.dataset.quotaAccounts + "/" + header.dataset.quotaDetail, count: entries.length, violations, windows };
};
`;

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
            ${measureQuota}
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

    for (const focused of [false, true]) {
      for (const accounts of [1, 2, 3]) {
        await t.test(`${focused ? "focused" : "list"} header, account count ${accounts}`, () => {
          const m = measureUiMarkup<{
            snapshots: {
              width: number;
              step: string;
              count: number;
              violations: string[];
              windows: { key: string; label: boolean; meter: boolean; percent: string }[];
            }[];
          }>(fixture.markup(390, true, focused), 390, `
            const header = document.querySelector(".workspace-head");
            let usage = header.querySelector(".header-usage");
            const entries = usage.querySelectorAll(".hu-provider");
            if (${accounts} === 1) entries[1].remove();
            if (${accounts} === 3) {
              const third = entries[0].cloneNode(true);
              third.querySelector(".hu-name").textContent = "fixture-extra";
              usage.append(third);
            }
            const original = usage.cloneNode(true);
            const fit = () => { ${fixture.compact} };
            ${measureQuota}
            const snapshots = [];
            const frame = window.frameElement;
            for (let width = 320; width <= 1024; width += 2) {
              frame.style.width = width + "px";
              const first = measure();
              for (const reset of usage.querySelectorAll(".hu-reset")) reset.textContent = "9s";
              const ticked = measure();
              const next = original.cloneNode(true);
              usage.replaceWith(next);
              usage = next;
              header.dataset.quotaAccounts = "0";
              header.dataset.quotaDetail = "percent";
              const rerendered = measure();
              const violations = [...first.violations, ...ticked.violations, ...rerendered.violations];
              if (first.step !== ticked.step) violations.push("countdown updates changed the step");
              if (first.step !== rerendered.step) violations.push("re-rendering changed the step");
              snapshots.push({ ...first, width: innerWidth, violations });
            }
            frame.style.width = "390px";
            const result = { snapshots };
          `, false, 800, ["--blink-settings=primaryPointerType=2,availablePointerTypes=2"]);
          const at390 = m.snapshots.find(snapshot => snapshot.width === 390);
          if (!focused) {
            assert.equal(at390?.count, 1, "one account fits the 390px list header");
            assert.deepEqual(at390?.violations, [], "the 390px list header keeps the badge and fits the entry");
          }
          const failures = m.snapshots.filter(snapshot => snapshot.violations.length);
          assert.deepEqual(failures.slice(0, 1), [], "every shown account fits and displays its provider badge");
          const narrow = m.snapshots.filter(({ step, count }) => count === 1 && step !== "1/full");
          const detail = new Set(narrow.map(({ windows }) => windows.length === 2
            ? "all windows" : windows[0]?.meter ? "one meter" : windows[0]?.label ? "window percent" : "percent only"));
          assert.deepEqual([...detail], ["percent only", "window percent", "one meter", "all windows"]);
          for (const { windows } of narrow.filter(snapshot => snapshot.windows.length === 1)) {
            assert.equal(windows[0]?.key, "weekly", "the lowest remaining window is kept");
            assert.equal(windows[0]?.percent, "40%");
          }
        });
      }
    }
  } finally { await fixture.close(); }
});
