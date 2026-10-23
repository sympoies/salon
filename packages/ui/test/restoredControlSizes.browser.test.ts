import { strict as assert } from "node:assert";
import { test } from "node:test";
import { hasHeadlessChrome, measureUiMarkup } from "./support/browserLayout.ts";
import { controlSizeFixture, sizeMeasurementScript } from "./support/controlSizeFixture.ts";

type Box = { height: number; width: number; font: number };
for (const width of [360, 412, 1280]) {
  test(`${width}px restores compact 0.3.35 control sizes and collapsed filters`, async t => {
    if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
    const mobile = width < 761;
    const markup = await controlSizeFixture(width);
    const m = measureUiMarkup<Record<string, Box>>(markup, width, sizeMeasurementScript + `
      result.inlineForm=!!document.querySelector('.session-filter-panel');
      result.popoverTrigger=!!document.querySelector('.session-filter-searchbar');
      result.overflow=document.documentElement.scrollWidth;
      const [backIcon,backLabel]=[...document.querySelector('.audit-detail .slot-back').children].map(e=>e.getBoundingClientRect());
      result.backInline=Math.abs(backIcon.top-backLabel.top)<1 && backIcon.right<=backLabel.left;
    `, false, 1050, mobile ? ["--blink-settings=primaryPointerType=2,availablePointerTypes=2"] : []);
    for (const name of ["logo", "more", "create"]) assert.equal(m[name]!.height, mobile ? 40 : 34, `${name} uses the toolbar size`);
    assert.equal(m.backInline as unknown as boolean, true, "Back arrow and label share one line");
    assert.equal(m.back!.height, 34, "Back keeps the 0.3.35 compact row height");
    assert.equal(m.detailPager!.height, 34, "pager matches compact detail controls");
    assert.equal(m.detailArrow!.width, 26, "pager arrows retain narrow 0.3.35 columns");
    for (const name of ["refresh", "copy", "close"]) assert.equal(m[name]!.height, mobile ? 34 : 30, `${name} keeps the common compact size`);
    assert.ok(Math.abs(m.role!.height - 24.8) < 0.1, "interactive role badge retains the 0.3.35 marker footprint");
    assert.equal(m.repo!.height, mobile ? 34 : 30, "repo tag matches the compact card controls");
    assert.equal(m.status!.height, mobile ? 34 : 30, "status pill matches the compact card controls");
    assert.equal(m.repo!.font, 11.52); assert.equal(m.status!.font, 11.52);
    for (const name of ["toast", "warning"]) assert.ok(Math.abs(m[name]!.height - 30.84375) < 0.1, `${name} retains the 0.3.35 surface height`);
    for (const name of ["toastClose", "warningClose"]) assert.equal(m[name]!.height, 16, `${name} retains the 0.3.35 dismiss size`);
    if (mobile) {
      assert.equal(m.filterBar!.height, 40, "both phone header rows share their baseline height");
      assert.equal(m.popoverTrigger, true, "phone keeps the collapsed filters");
    } else {
      assert.equal(m.popoverTrigger, true, "desktop keeps filters behind the compact control");
      assert.equal(m.inlineForm, false, "desktop has no inline form");
    }
    assert.ok((m.overflow as unknown as number) <= width, "no horizontal page overflow");
  });
}

test("expanded desktop panel Hosts/Roles keep reset and choices clickable", async t => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const markup = await controlSizeFixture(1280, undefined, true);
  const m = measureUiMarkup<{ expanded: boolean; resetClickable: boolean; choicesClickable: boolean }>(markup, 1280, `
    const panel=document.querySelector('.session-filter-panel');
    const sections=[...panel.querySelectorAll('details')];
    const hit=e=>{const r=e.getBoundingClientRect(),h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return h===e||e.contains(h)};
    const result={expanded:sections.every(e=>e.open),resetClickable:sections.every(e=>hit(e.querySelector('.session-filter-facet-all'))),choicesClickable:sections.every(e=>hit(e.querySelector('input[type="checkbox"]')))};
  `);
  assert.ok(m.expanded, "Hosts/Roles open expanded inside the panel");
  assert.ok(m.resetClickable, "All hosts and All roles remain reachable");
  assert.ok(m.choicesClickable, "facet checkboxes remain reachable");
});

for (const width of [360, 412, 1280]) test(`${width}px repair warnings retain their compact 0.3.35 action and surface height`, t => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const m = measureUiMarkup<{ toast: number; action: number }>(`<div class="repair-toast is-attention"><span>Some panes need repair</span><div class="repair-toast-actions"><button class="btn ghost">Review</button></div></div>`, width, `
    const result={toast:document.querySelector('.repair-toast').getBoundingClientRect().height,action:document.querySelector('.repair-toast-actions .btn').getBoundingClientRect().height};
  `, false, 800, width < 761 ? ["--blink-settings=primaryPointerType=2,availablePointerTypes=2"] : []);
  assert.equal(m.action, 30, "repair action retains its original 30px height");
  assert.equal(m.toast, 48, "warning padding and small action retain the original surface height");
});
