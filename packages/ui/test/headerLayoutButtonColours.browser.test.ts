import { strict as assert } from "node:assert";
import { test } from "node:test";
import { hasHeadlessChrome, measureUiMarkup } from "./support/browserLayout.ts";
import { headerFixture } from "./support/headerFixture.ts";

// #981: the collapsed layout button uses the same colours as the header's
// other icon buttons (the More button), in both themes.
interface Colours { background: string; border: string; borderWidth: string; color: string }
interface Measure { stage: string | null; visible: boolean; layout: Colours; more: Colours }

for (const theme of ["dark", "paper"] as const) {
  for (const width of [1500, 1920]) {
    test(`the collapsed layout button matches the More button at ${width}px in the ${theme} theme`, async t => {
      if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
      const fixture = await headerFixture();
      try {
        const m = measureUiMarkup<Measure>(fixture.markup(width), width, `
          document.documentElement.dataset.theme=${JSON.stringify(theme)};
          ${fixture.compact}
          const header=document.querySelector('.workspace-head');
          const colours=e=>{const c=getComputedStyle(e);return {background:c.backgroundColor,border:c.borderTopColor,borderWidth:c.borderTopWidth,color:c.color};};
          const layout=header.querySelector('.layout-picker-trigger');
          const result={stage:header.dataset.headerCompact,visible:layout.getBoundingClientRect().width>0,
            layout:colours(layout),more:colours(header.querySelector('.header-menu-trigger'))};
        `, false, 982);
        const detail = JSON.stringify(m);
        assert.notEqual(m.stage, "0", `the layouts are collapsed into the button: ${detail}`);
        assert.equal(m.visible, true, detail);
        assert.deepEqual(m.layout, m.more, `same background, border and icon colour as More: ${detail}`);
      } finally { await fixture.close(); }
    });
  }
}
