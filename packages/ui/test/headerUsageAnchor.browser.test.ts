import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ProviderUsage } from "../src/api.ts";
import { hasHeadlessChrome } from "./support/browserLayout.ts";
import { measureHeaderMarkup as measureUiMarkup } from "./support/headerFixture.ts";
import { createUiSsrHarness, renderComponent } from "./support/ssr.ts";

const now = 1_800_000_000_000;
const providers: ProviderUsage[] = [{
  provider: "codex", account: "fixture", label: "Codex", ok: true, stale: false, plan: "pro",
  windows: [{ key: "5h", label: "5h", used_percent: 8, window_minutes: 300, resets_at: now / 1000 + 7200 }],
  updated_at: now / 1000, note: null, error: null, reason_code: null,
}];

for (const width of [1800, 390]) {
  test(`${width}px clicking header usage keeps its box fixed and anchors expanded details below it`, async t => {
    if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
    const harness = createUiSsrHarness();
    try {
      const { HeaderUsageReadout } = await harness.loadModule<typeof import("../src/HeaderUsage.tsx")>("/src/HeaderUsage.tsx");
      const usage = renderComponent(HeaderUsageReadout, { providers, now, onOpen() {} })
        .replace('class="header-usage"', 'class="header-usage" style="display:inline-flex;left:50vw;top:28px"');
      const fixture = `<main class="dash workspace-shell"><header class="dash-head workspace-head">
        <div class="workspace-head-start"><div class="brand-title"><span class="brand-title-mark">A</span><h1>Agent Console</h1></div></div>
        ${usage}<div class="dash-actions"><button>New</button></div>
      </header></main>`;
      const measured = measureUiMarkup<{
      before: { x: number; y: number; width: number; height: number };
      after: { x: number; y: number; width: number; height: number };
      panelTop: number;
      panelLeft: number;
      buttonLeft: number;
      buttonRight: number;
      viewportWidth: number;
      }>(fixture, width, `
      const button=document.querySelector('.header-usage');
      const box=el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}};
      const before=box(button);
      button.addEventListener('click',event=>{
        const anchor=event.currentTarget.getBoundingClientRect();
        const panel=document.createElement('section');
        panel.className='modal page-overlay usage-anchored';
        panel.style.setProperty('--usage-anchor-center',(anchor.left+anchor.width/2)+'px');
        panel.style.setProperty('--usage-anchor-bottom',anchor.bottom+'px');
        panel.innerHTML='<div class="dash usage-panel"><header class="dash-head"><h1>Usage</h1></header><p>Usage details</p></div>';
        panel.setAttribute('role','dialog');
        document.body.append(panel);
      });
      button.click();
      const panel=document.querySelector('.usage-anchored');
      const after=box(button),p=panel.getBoundingClientRect(),b=button.getBoundingClientRect();
      const result={before,after,panelTop:p.top,panelLeft:p.left,buttonLeft:b.left,buttonRight:b.right,viewportWidth:innerWidth};
      `);
      assert.equal(measured.viewportWidth, width);
      assert.deepEqual(measured.after, measured.before, "clicking leaves the quota bar's x/y/width/height unchanged");
      assert.ok(Math.abs(measured.panelTop - (measured.after.y + measured.after.height + 8)) <= 1,
        `expanded content starts 8px below the quota bar (${measured.panelTop} vs ${measured.after.y + measured.after.height + 8})`);
      assert.ok(measured.panelLeft >= 0 && measured.panelLeft < width);
      assert.ok(measured.buttonLeft >= 0 && measured.buttonRight <= width);
    } finally {
      await harness.close();
    }
  });
}
