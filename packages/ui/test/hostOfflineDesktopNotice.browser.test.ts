import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderNoticeSurface } from "./support/noticeSurfaces.ts";
import { measureHeaderMarkup } from "./support/headerFixture.ts";

// The former filter-field placement is intentionally replaced by the title-bar end.
for (const width of [900, 1024, 1025, 1200, 1440, 2000]) {
  test(`${width}px desktop host-offline notice stays readable at the title-bar end`, async () => {
    const markup = await renderNoticeSurface("dashboard", width, { restore: false, macTitleBar: true,
      error: "very-long-production-machine-name: offline (cooling down after a failed probe)" });
    const m = measureHeaderMarkup<{ inTitleBar: boolean; readable: boolean; dismissClickable: boolean; atEnd: boolean; overflow: boolean }>(markup, width, `
      const pill=document.querySelector('.connection-notice'),p=pill.getBoundingClientRect();
      const bar=pill.closest('.mac-titlebar'),b=bar?.getBoundingClientRect();
      const text=pill.querySelector('.connection-notice-message-full'),r=text.getBoundingClientRect();
      const dismiss=pill.querySelector('button'),d=dismiss.getBoundingClientRect(),hit=document.elementFromPoint(d.x+d.width/2,d.y+d.height/2);
      const result={inTitleBar:!!bar,readable:r.width>=120&&p.width>r.width,
        dismissClickable:hit===dismiss||dismiss.contains(hit),atEnd:!!b&&Math.abs(p.right-b.right)<=12,
        overflow:document.documentElement.scrollWidth>innerWidth};
    `);
    assert.equal(m.inTitleBar, true);
    assert.equal(m.readable, true, "full notice text remains readable at desktop widths");
    assert.equal(m.atEnd, true);
    assert.equal(m.dismissClickable, true);
    assert.equal(m.overflow, false);
  });
}
