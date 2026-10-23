import { strict as assert } from "node:assert";
import { test } from "node:test";
import { hasHeadlessChrome, measureUiMarkup } from "./support/browserLayout.ts";
import { headerFixture } from "./support/headerFixture.ts";

for (const native of [false, true]) test(`active Scope retains readable text in ${native ? "native dock" : "phone"} header`, async t => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const fixture = await headerFixture();
  try {
    const width = native ? 1100 : 370;
    const result = measureUiMarkup<{ labelWidth: number; bounded: boolean }>(fixture.markup(width), width, `
      const header=document.querySelector('.workspace-head');
      document.querySelectorAll('.session-filter-chip:not([data-filter-chip="scope"])').forEach(chip=>chip.remove());
      ${native ? "header.classList.add('has-native-counts');header.style.width='724px';header.querySelector('.session-status-counts').remove();" : ""}
      ${fixture.compact}
      const label=header.querySelector('[data-filter-chip="scope"] .session-filter-chip-label');
      const rect=label.getBoundingClientRect(), bounds=header.getBoundingClientRect();
      const result={labelWidth:rect.width,bounded:rect.left>=bounds.left&&rect.right<=bounds.right};
    `);
    assert.ok(result.labelWidth >= 40, `Scope prefix remains readable: ${JSON.stringify(result)}`);
    assert.equal(result.bounded, true);
  } finally { await fixture.close(); }
});
