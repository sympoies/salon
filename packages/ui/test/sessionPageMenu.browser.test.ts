import { strict as assert } from "node:assert";
import { test } from "node:test";
import { hasHeadlessChrome } from "./support/browserLayout.ts";
import { headerFixture, measureHeaderMarkup } from "./support/headerFixture.ts";

// #937: in the macOS app the brand and counts move to the title bar, so the pager
// sits at the window's left edge; a menu centred on it was cut off ("e 1").
test("page menu labels stay readable when the pager is at the window edge or after the brand", async t => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const fixture = await headerFixture();
  try {
    for (const [width, mac] of [[1920, true], [1440, true], [1024, true], [761, true], [1440, false], [761, false], [412, false], [360, true]] as const) {
      let markup = fixture.markup(width);
      // The macOS shell renders the brand in its title bar and portals the status counts
      // into #mac-titlebar-counts (MacTitleBar), leaving the pager first in the row.
      if (mac) markup = `<script>document.documentElement.dataset.macTitlebar="true"</script>${markup.replace(/<div class="brand-title".*?<\/h1><\/div>/s, "")}`
        + `<div class="mac-titlebar"><div id="mac-titlebar-counts"></div></div><script>document.getElementById("mac-titlebar-counts").append(document.querySelector(".session-status-counts"))</script>`;
      assert.equal(markup.includes("brand-title"), !mac, `${width}px brand placement matches the shell`);
      const m = measureHeaderMarkup<{ unreadable: string[]; menuLeft: number; menuRight: number; viewportWidth: number; countsInRow: boolean }>(markup, width, `
        const picker=document.querySelector('.session-list-page-picker'),menu=document.createElement('div');
        menu.className='session-list-page-menu';menu.setAttribute('role','menu');
        for(let page=1;page<=5;page++){const item=document.createElement('button');item.type='button';item.setAttribute('role','menuitem');
          item.className='control-menu slot-menu-item session-list-page-menu-item';item.textContent='Page '+page;menu.append(item);}
        picker.append(menu);
        const unreadable=[...menu.children].filter(item=>{const range=document.createRange();range.selectNodeContents(item);const r=range.getBoundingClientRect();
          return r.left<0||r.right>innerWidth||![0.02,0.5,0.98].every(f=>item.contains(document.elementFromPoint(r.left+r.width*f,r.top+r.height/2)));}).map(item=>item.textContent);
        const box=menu.getBoundingClientRect();
        const result={unreadable,menuLeft:box.left,menuRight:box.right,countsInRow:!!document.querySelector('.workspace-head .session-status-counts')};
      `);
      const label = `${mac ? "macOS" : "web"} ${width}px`;
      assert.equal(m.countsInRow, !mac, `${label}: status counts placement matches the shell`);
      assert.deepEqual(m.unreadable, [], `${label}: every page label is fully on screen and hit-testable`);
      assert.ok(m.menuLeft >= 0 && m.menuRight <= m.viewportWidth, `${label}: menu inside viewport (${m.menuLeft}..${m.menuRight})`);
    }
  } finally { await fixture.close(); }
});

// #952: opening the page menu must not change the header layout. The open menu
// overflows the pager, and compaction read that as a pager that does not fit.
test("opening the page menu keeps the header's compaction, logo and centered quotas", async t => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const fixture = await headerFixture();
  try {
    for (const [width, mac] of [[1500, false], [1024, false], [1500, true], [1024, true]] as const) {
      let markup = fixture.markup(width);
      if (mac) markup = `<script>document.documentElement.dataset.macTitlebar="true"</script>${markup.replace(/<div class="brand-title".*?<\/h1><\/div>/s, "")}`
        + `<div class="mac-titlebar"><div id="mac-titlebar-counts"></div></div><script>document.getElementById("mac-titlebar-counts").append(document.querySelector(".session-status-counts"))</script>`;
      const m = measureHeaderMarkup<{ closed: string[]; open: string[] }>(markup, width, `
        const head=document.querySelector('.workspace-head');
        const shown=selector=>{const el=head.querySelector(selector);if(!el)return 'absent';const r=el.getBoundingClientRect();return r.width>0&&r.height>0?'shown':'hidden';};
        const snapshot=()=>[head.dataset.headerCompact,shown('.brand-title'),shown('.header-usage'),shown('.session-list-pagination')];
        {${fixture.compact}}
        const closed=snapshot();
        const picker=document.querySelector('.session-list-page-picker'),menu=document.createElement('div');
        menu.className='session-list-page-menu';menu.setAttribute('role','menu');
        for(let page=1;page<=3;page++){const item=document.createElement('button');item.type='button';item.setAttribute('role','menuitem');
          item.className='control-menu slot-menu-item session-list-page-menu-item';item.textContent='Page '+page;menu.append(item);}
        picker.append(menu);
        {${fixture.compact}}
        const result={closed,open:snapshot()};
      `);
      const label = `${mac ? "macOS" : "web"} ${width}px`;
      assert.equal(m.closed[3], "shown", `${label}: the pager is in the row`);
      assert.deepEqual(m.open, m.closed, `${label}: [stage, logo, quotas, pager] stay the same with the menu open`);
    }
  } finally { await fixture.close(); }
});
