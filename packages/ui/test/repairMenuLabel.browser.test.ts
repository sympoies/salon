import { strict as assert } from "node:assert";
import { test } from "node:test";
import { hasHeadlessChrome, measureUiMarkup } from "./support/browserLayout.ts";
import { createUiSsrHarness, renderComponent } from "./support/ssr.ts";

test("the Repair menu label stays on one line at phone and desktop widths", async (t) => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const harness = createUiSsrHarness();
  try {
    const { HeaderMenu } = await harness.loadModule<typeof import("../src/HeaderMenu.tsx")>("/src/HeaderMenu.tsx");
    const { BrandTitle } = await harness.loadModule<typeof import("../src/BrandTitle.tsx")>("/src/BrandTitle.tsx");
    const menu = renderComponent(HeaderMenu, {
      open: true, onOpenChange() {}, historyAvailable: true,
      onHistory() {}, onUsage() {}, onDebug() {}, onSettings() {}, onRepair() {},
    });
    const brand = renderComponent(BrandTitle, { onMarkClick() {} });
    const markup = `<main class="dash workspace-shell"><header class="dash-head workspace-head">`
      + `<div class="workspace-head-start">${brand}</div>`
      + `<div class="dash-actions"><div class="dash-create-actions">${menu}<button class="btn">New</button></div></div>`
      + `</header></main>`;
    for (const width of [360, 1440]) {
      const measured = measureUiMarkup<{ text: string; lines: number; visible: boolean }>(markup, width, `
        const item=[...document.querySelectorAll('.header-menu-item')].find(el=>el.textContent.trim()==='Repair');
        if(!item)throw new Error('missing Repair menu item');
        const range=document.createRange();range.selectNodeContents(item);
        const lines=new Set([...range.getClientRects()].filter(r=>r.width>.5&&r.height>.5).map(r=>Math.round(r.top))).size;
        const rect=item.getBoundingClientRect();
        const result={text:item.textContent.trim(),lines,visible:rect.width>0&&rect.height>0};
      `);
      assert.equal(measured.text, "Repair");
      assert.equal(measured.visible, true, `${width}px: the item is rendered`);
      assert.equal(measured.lines, 1, `${width}px: the label occupies one text row`);
    }
  } finally { await harness.close(); }
});
