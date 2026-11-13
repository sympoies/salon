import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { measureHeaderMarkup } from "./support/headerFixture.ts";
import { renderNoticeSurface } from "./support/noticeSurfaces.ts";

interface Box { top: number; right: number; bottom: number; left: number; height: number; width: number }
interface Measurement {
  header: Box; clearHeader: Box; pill: Box; button: Box; message: Box;
  dismissClickable: boolean; spinnerVisible: boolean; nowrap: string; ellipsis: string; overflow: string;
}

const cases = [
  { width: 384, height: 832, layout: "desktop" },
  { width: 760, height: 832, layout: "desktop" },
  { width: 761, height: 832, layout: "desktop" },
  { width: 1280, height: 900, layout: "desktop" },
  { width: 384, height: 832, layout: "mobile" },
] as const;
for (const { width, height, layout } of cases) for (const kind of ["unreachable", "host-offline"] as const) {
  test(`${layout} ${width}x${height} ${kind} header notice stays on one bounded line without reflow`, async () => {
    const markup = await renderNoticeSurface("dashboard", width, {
      restore: false, androidLayout: layout,
      error: kind === "host-offline" ? "fixture-source: offline (cooling down after an unsuccessful connection attempt)" : undefined,
    });
    const evidence = process.env.AGENT_CONSOLE_UI_SCREENSHOT_DIR;
    const name = `${layout}-${width}-${kind}`;
    if (evidence) mkdirSync(evidence, { recursive: true });
    const setup = `document.documentElement.dataset.phoneHeader='true';document.documentElement.dataset.phoneTier='${layout === "mobile"}';${layout === "desktop" ? "document.documentElement.dataset.androidDesktop='true';" : ""}`;
    const m = measureHeaderMarkup<Measurement>(markup, width, `
      parent.document.head.insertAdjacentHTML('beforeend','<style>#measurement{display:none}</style>');parent.document.body.style.margin='0';
      const box = el => { const r=el.getBoundingClientRect(); return {top:r.top,right:r.right,bottom:r.bottom,left:r.left,height:r.height,width:r.width}; };
      const pill=document.querySelector('.connection-notice'),layer=pill.parentElement;
      const header=document.querySelector('.workspace-head'),button=header.querySelector('.session-status-count');
      const message=pill.querySelector('.connection-notice-message'),style=getComputedStyle(message);
      const dismiss=pill.querySelector('button'),d=dismiss.getBoundingClientRect();
      const hit=document.elementFromPoint(d.x+d.width/2,d.y+d.height/2);
      const spinner=pill.querySelector('.connection-notice-spinner');
      const result={header:box(header),pill:box(pill),button:box(button),message:box(message),
        dismissClickable:hit===dismiss||dismiss.contains(hit),
        spinnerVisible:!!spinner&&box(spinner).width>0&&box(spinner).right<=innerWidth,
        nowrap:style.whiteSpace,ellipsis:style.textOverflow,overflow:style.overflowX};
      layer.style.display='none';result.clearHeader=box(header);layer.style.display='';
    `, false, height, evidence ? [`--screenshot=${join(evidence, `${name}.png`)}`] : [], setup);
    if (evidence) writeFileSync(join(evidence, `${name}.json`), JSON.stringify(m, null, 2));
    const detail = JSON.stringify(m);
    assert.equal(m.pill.height, m.button.height, `notice matches header button height: ${detail}`);
    assert.ok(m.pill.left >= 0 && m.pill.right <= width, `notice stays within viewport: ${detail}`);
    assert.equal(m.header.top, m.clearHeader.top, "notice keeps the header top fixed");
    assert.equal(m.header.height, m.clearHeader.height, "notice keeps the header height fixed");
    assert.equal(m.nowrap, "nowrap");
    assert.equal(m.ellipsis, "ellipsis");
    assert.equal(m.overflow, "hidden");
    assert.ok(m.message.width > 0, "message retains visible space");
    assert.equal(m.dismissClickable, true, "dismissal remains reachable");
    if (kind === "unreachable") assert.equal(m.spinnerVisible, true, "retry spinner remains visible");
  });
}
