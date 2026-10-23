import { strict as assert } from "node:assert";
import { test } from "node:test";
import { hasHeadlessChrome, measureUiMarkup } from "./support/browserLayout.ts";

// The Working row as HistoryConversation renders it (#942, #963; its structure
// is pinned in sessionConversationPane.test.ts), in each consumer wrapper.
const WORKING = '<div class="history-messages"><p class="history-working" role="status">Working<span class="history-working-dots" aria-hidden="true"><span></span><span></span><span></span></span></p></div>';
const WRAPPERS = ["phone-conversation-pane", "slot-conversation-pane", "conversation-dock"];

interface RowMeasurement {
  wrapper: string;
  baseline: number;
  dotsBottom: number[];
  height: number;
  textOnlyHeight: number;
  animation: string;
}

// #966: the dots sit on the text baseline, like a typed ellipsis ("Working..."),
// not centered on the line, and they do not change the row's height.
for (const width of [390, 1500]) for (const reducedMotion of [true, false]) {
  test(`#966 the Working dots sit on the text baseline (${width}px, ${reducedMotion ? "reduced motion" : "animated"})`, t => {
    if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
    const markup = WRAPPERS.map(className => `<section class="${className}" style="position:static;width:100%;height:120px">${WORKING}</section>`).join("");
    const result = measureUiMarkup<{ rows: RowMeasurement[] }>(markup, width, `
      const rows=[...document.querySelectorAll('.history-working')].map(line=>{
        const wrapper=line.closest('section').className;
        const dots=[...line.querySelectorAll('.history-working-dots > span')];
        // Hold the animation at rest so the bounce does not move the boxes.
        for(const dot of dots)dot.style.animationPlayState='paused';
        const animation=getComputedStyle(dots[0]).animationName;
        const height=line.getBoundingClientRect().height;
        // A zero-size inline-block at the end of the text marks the baseline.
        const text=document.createElement('span'),marker=document.createElement('span');
        marker.style.cssText='display:inline-block;width:0;height:0';
        line.insertBefore(text,line.firstChild);text.append(text.nextSibling,marker);
        const baseline=marker.getBoundingClientRect().bottom;
        const dotsBottom=dots.map(dot=>dot.getBoundingClientRect().bottom);
        const box=line.querySelector('.history-working-dots');box.remove();
        const textOnlyHeight=line.getBoundingClientRect().height;
        return {wrapper,baseline,dotsBottom,height,textOnlyHeight,animation};
      });
      const result={rows};
    `, reducedMotion);
    assert.deepEqual(result.rows.map(row => row.wrapper), WRAPPERS, "every consumer wrapper renders the row");
    for (const row of result.rows) {
      const label = `${row.wrapper} at ${width}px`;
      // Paused at the keyframe start, the dots rest at translateY(0).
      for (const bottom of row.dotsBottom) {
        assert.ok(Math.abs(bottom - row.baseline) <= 0.5, `${label}: dot bottom ${bottom} on the text baseline ${row.baseline}`);
      }
      assert.ok(Math.abs(row.height - row.textOnlyHeight) <= 0.5, `${label}: the dots keep the row height (${row.height} vs ${row.textOnlyHeight})`);
      assert.equal(row.animation, reducedMotion ? "none" : "history-working-dot", `${label}: the animation is unchanged`);
    }
  });
}
