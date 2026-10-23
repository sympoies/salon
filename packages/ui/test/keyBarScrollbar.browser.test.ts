import { strict as assert } from "node:assert";
import { test } from "node:test";
import { hasHeadlessChrome, measureUiMarkup } from "./support/browserLayout.ts";

interface KeyBarGeometry {
  readonly coarse: boolean;
  readonly overflows: boolean;
  readonly overflowX: string;
  readonly scrollbarThickness: number;
  readonly rowHeight: number;
  readonly expectedRowHeight: number;
}

// #946: the phone key row scrolls by touch but must not draw a scrollbar track.
// Chrome runs with classic scrollbars here (no --hide-scrollbars) so a drawn
// track takes layout height exactly as it does in the Android WebView.
const keys = ["Upload", "Voice", "Esc", "Tab", "←", "→", "↑", "↓"]
  .map((label) => `<button type="button" class="control-key key">${label}</button>`).join("");
const markup = `<div class="terminal-pane with-key-bar" style="position:static;width:100%"><div class="key-bar-group"><div class="key-bar" aria-label="Special keys">${keys}</div></div></div>`;

const COARSE = ["--blink-settings=primaryPointerType=2,availablePointerTypes=2"];

function measureKeyBar(width: number, chromeArgs: readonly string[]): KeyBarGeometry {
  return measureUiMarkup<KeyBarGeometry>(markup, width, `
    const bar=document.querySelector('.key-bar');
    const cs=getComputedStyle(bar);
    const keyHeight=Math.max(...[...bar.querySelectorAll('.key')].map(k=>k.getBoundingClientRect().height));
    const padding=parseFloat(cs.paddingTop)+parseFloat(cs.paddingBottom)+parseFloat(cs.borderTopWidth)+parseFloat(cs.borderBottomWidth);
    const result={
      coarse:matchMedia('(pointer: coarse)').matches,
      overflows:bar.scrollWidth>bar.clientWidth,
      overflowX:cs.overflowX,
      scrollbarThickness:bar.offsetHeight-bar.clientHeight-parseFloat(cs.borderTopWidth)-parseFloat(cs.borderBottomWidth),
      rowHeight:bar.getBoundingClientRect().height,
      expectedRowHeight:keyHeight+padding,
    };
  `, false, 800, chromeArgs, false);
}

for (const width of [360, 384, 430]) {
  test(`the phone key row draws no scrollbar and is as tall as its buttons at ${width}px`, (t) => {
    if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
    const m = measureKeyBar(width, COARSE);
    assert.equal(m.coarse, true, `the browser uses a coarse pointer: ${JSON.stringify(m)}`);
    assert.equal(m.overflows, true, `the row still overflows horizontally: ${JSON.stringify(m)}`);
    assert.equal(m.overflowX, "auto", `the row still scrolls by touch: ${JSON.stringify(m)}`);
    assert.equal(m.scrollbarThickness, 0, `no horizontal scrollbar track is drawn: ${JSON.stringify(m)}`);
    assert.ok(Math.abs(m.rowHeight - m.expectedRowHeight) <= 0.5, `row height is buttons plus padding only: ${JSON.stringify(m)}`);
  });
}

test("a fine-pointer window keeps the key row scrollbar so a mouse can still scroll it", (t) => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const m = measureKeyBar(384, []);
  assert.equal(m.coarse, false, `the browser uses a fine pointer: ${JSON.stringify(m)}`);
  assert.equal(m.overflowX, "auto", `the row stays scrollable: ${JSON.stringify(m)}`);
  assert.ok(m.scrollbarThickness > 0, `desktop keeps its scrollbar: ${JSON.stringify(m)}`);
});
