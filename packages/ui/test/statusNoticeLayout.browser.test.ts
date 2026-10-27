import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderNoticeSurface, type NoticeSurface } from "./support/noticeSurfaces.ts";

import { hasHeadlessChrome } from "./support/browserLayout.ts";
import { measureHeaderMarkup as measureUiMarkup } from "./support/headerFixture.ts";

for (const width of [1280, 412, 360]) {
  for (const surface of ["dashboard", "shell"] as const) {
    test(`${width}px real ${surface} notice clears controls and preserves pane bounds`, async (t) => {
      if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
      const markup = await renderNoticeSurface(surface, width);
      const result = measure(markup, surface, width);
      assert.deepEqual(result.withNotice, result.withoutNotice, "showing a notice must not move or resize the real pane");
      if (surface === "dashboard") assert.ok(result.inHeaderSlot && result.atSlotRight && result.pillVisible, `connection notice stays visible at the header slot right edge: ${JSON.stringify(result)}`);
      else assert.ok(result.noticeTop >= result.controlsBottom, `notice top ${result.noticeTop} must clear controls bottom ${result.controlsBottom}`);
      assert.ok(result.controlsClickable, `notice must not intercept any surface control: ${result.blocker ?? ""}`);
      assert.equal(result.layerPointerEvents, "none");
      assert.equal(result.pillPointerEvents, "auto");
      assert.ok(result.pillClickable, "dismiss button remains clickable");
      assert.ok(result.noticeBottom < 730, "notice stays above the simulated keyboard area");
      assert.notEqual(result.shadow, "none", "notice uses a defined elevation token");
      assert.equal(result.reducedAnimation, "none", "spinner respects reduced motion");
    });
  }
}

interface Bounds { x: number; y: number; width: number; height: number }
interface Measurement {
  withNotice: Bounds; withoutNotice: Bounds; noticeTop: number; noticeBottom: number; controlsBottom: number;
  controlsClickable: boolean; pillClickable: boolean; layerPointerEvents: string; pillPointerEvents: string;
  shadow: string; reducedAnimation: string; blocker?: string; inHeaderSlot: boolean; atSlotRight: boolean; pillVisible: boolean;
}
function measure(markup: string, surface: NoticeSurface, width: number): Measurement {
    const paneSelector = surface === "dashboard" ? ".session-workspace, .mobile-session-list" : ".terminal-pane";
    const focusedDashboard = surface === "dashboard" && markup.includes("slot-focus-toolbar");
    const controlSelector = surface === "dashboard" ? focusedDashboard ? ".terminal-slot.is-focused .slot-head" : ".workspace-head, .slot-session-card-header" : ".shell-page-header, .shell-page-status";
    return measureUiMarkup<Measurement>(markup, width, `
      const pane=document.querySelector('${paneSelector}');
      const layer=document.querySelector('.connection-notice-layer');
      const pill=document.querySelector('.connection-notice');
      const bounds=()=>{const r=pane.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}};
      const withNotice=bounds();layer.hidden=true;layer.style.display='none';const withoutNotice=bounds();layer.hidden=false;layer.style.display='';
      const controls=[...document.querySelectorAll('${controlSelector}')];
      const controlsBottom=Math.max(...controls.map(el=>el.getBoundingClientRect().bottom));
      const dialog=document.querySelector('.session-filter-panel');
      const controlRoots=dialog ? [dialog] : controls;
      const controlButtons=controlRoots.flatMap(el=>[...el.querySelectorAll('button,select,input')]).filter(el=>!el.closest('[hidden]')&&!el.closest('details:not([open])')&&el.getBoundingClientRect().width>0&&el.getBoundingClientRect().height>0);
      let blocker;
      const controlsClickable=controlButtons.every(el=>{
        const r=el.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;
        for(let parent=el.parentElement;parent;parent=parent.parentElement){
          const style=getComputedStyle(parent),p=parent.getBoundingClientRect();
          if(/auto|scroll|hidden|clip/.test(style.overflowY)&&(y<p.top||y>p.bottom))return true;
        }
        const hit=document.elementFromPoint(x,y);
        // Phone notices intentionally overlay persistent counts at the row end.
        if(el.matches('.session-status-count')&&hit?.closest('.connection-notice')&&el.closest('.session-filter-status-row, .slot-focus-strip'))return true;
        const clickable=el===hit||el.contains(hit);
        if(!clickable)blocker=(el.getAttribute('aria-label')||el.textContent)+' blocked by '+hit?.className;
        return clickable;
      });
      const dismiss=pill.querySelector('button');const d=dismiss.getBoundingClientRect();const hit=document.elementFromPoint(d.x+d.width/2,d.y+d.height/2);
      const row=layer.closest('.session-filter-trigger-row, .session-filter-status-row, .slot-head, .slot-focus-strip');
      const slot=row;
      const p=pill.getBoundingClientRect(),r=slot?.getBoundingClientRect();
      const result={withNotice,withoutNotice,controlsBottom,controlsClickable,blocker,
        noticeTop:pill.getBoundingClientRect().top,noticeBottom:pill.getBoundingClientRect().bottom,
        layerPointerEvents:getComputedStyle(layer).pointerEvents,pillPointerEvents:getComputedStyle(pill).pointerEvents,
        pillClickable:dismiss===hit||dismiss.contains(hit),shadow:getComputedStyle(pill).boxShadow,
        inHeaderSlot:!!r && p.top>=r.top && p.bottom<=r.bottom,atSlotRight:!!r && Math.abs(r.right-p.right)<=10,
        pillVisible:p.width>=60 && getComputedStyle(pill).clipPath==='none',
        reducedAnimation:pill.querySelector('.connection-notice-spinner') ? getComputedStyle(pill.querySelector('.connection-notice-spinner')).animationName : 'none'};
    `, true);
}

for (const width of [1280, 412, 360]) {
  test(`${width}px restored Dashboard status remains visible in the same header slot`, async (t) => {
    if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
    const result = measure(await renderNoticeSurface("dashboard", width, { restore: true }), "dashboard", width);
    assert.ok(result.inHeaderSlot && result.atSlotRight && result.pillVisible, JSON.stringify(result));
    assert.deepEqual(result.withNotice, result.withoutNotice);
    assert.ok(result.controlsClickable, result.blocker);
    assert.ok(result.pillClickable, "restored dismissal remains usable");
  });
}

for (const width of [1280, 360]) {
  for (const restore of [false, true]) {
    test(`${width}px focused connection ${restore ? "restored" : "lost"} stays in its header row`, async (t) => {
      if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
      const result = measure(await renderNoticeSurface("dashboard", width, { restore, focused: true }), "dashboard", width);
      assert.ok(result.inHeaderSlot && result.atSlotRight && result.pillVisible, JSON.stringify(result));
      assert.ok(result.controlsClickable, result.blocker);
      assert.ok(result.pillClickable);
    });
  }
}
