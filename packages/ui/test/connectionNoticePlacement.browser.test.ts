import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { renderNoticeSurface } from "./support/noticeSurfaces.ts";

// Production Dashboard/TitleBar markup and CSS; only transport/terminal are synthetic.
for (const [width, macTitleBar] of [[360, false], [412, false], [600, false], [601, false], [760, false], [800, true], [1280, true]] as const) {
  for (const phoneFocusCounts of macTitleBar ? [true] : [true, false]) {
    test(`${width}px ${macTitleBar ? "title bar" : `phone counts ${phoneFocusCounts}`}: notice fits its row and dismissal is clickable`, async () => {
      const markup = await renderNoticeSurface("dashboard", width, { focused: true, restore: true, phoneFocusCounts, macTitleBar });
      const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
      const temp = mkdtempSync(join(tmpdir(), "notice-placement-"));
      const evidence = process.env.AGENT_CONSOLE_UI_SCREENSHOT_DIR;
      const name = `notice-${width}-${phoneFocusCounts ? "counts" : "notice-only"}`;
      try {
        const frame = `<!doctype html><html ${macTitleBar ? 'data-mac-titlebar="true"' : ""}><style>${css}</style>${markup}<script>
          const pill=document.querySelector('.connection-notice'), p=pill.getBoundingClientRect();
          const row=pill.closest('${macTitleBar ? ".mac-titlebar" : ".slot-focus-strip"}'),r=row?.getBoundingClientRect();
          const counts=document.querySelector('${macTitleBar ? "#mac-titlebar-counts" : ".slot-focus-strip"} .session-status-counts'),c=counts?.getBoundingClientRect();
          const dismiss=pill.querySelector('button'),d=dismiss.getBoundingClientRect(),hit=document.elementFromPoint(d.x+d.width/2,d.y+d.height/2);
          const drag=document.querySelector('.mac-titlebar-space'),g=drag?.getBoundingClientRect();
          const result={width:innerWidth,extraRows:document.querySelectorAll('.slot-connection-row').length,
            row: r?{top:r.top,bottom:r.bottom,height:r.height,right:r.right}:null,
            notice:{left:p.left,right:p.right,top:p.top,bottom:p.bottom,width:p.width},
            countsRight:c?.right??0,countsVisible:!!c?.width,
            dismissClickable:hit===dismiss||dismiss.contains(hit),
            dragClickable:!g||document.elementFromPoint(g.x+g.width/2,g.y+g.height/2)===drag,
            overflow:document.documentElement.scrollWidth>innerWidth};
          parent.document.querySelector('#measurement').textContent=JSON.stringify(result);
        </script></html>`;
        const path = join(temp, "fixture.html");
        writeFileSync(path, `<!doctype html><style>body{margin:0}iframe{display:block;border:0}</style><iframe width="${width}" height="800"></iframe><pre id="measurement" hidden></pre><script>document.querySelector('iframe').srcdoc=${JSON.stringify(frame).replaceAll("<", "\\u003c")}</script>`);
        if (evidence) mkdirSync(evidence, { recursive: true });
        const browser = spawnSync(process.env.CHROME_BIN ?? "google-chrome", ["--headless", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
          `--window-size=${Math.max(width, 800)},850`, "--virtual-time-budget=3000", "--dump-dom",
          ...(evidence ? [`--screenshot=${join(evidence, `${name}.png`)}`] : []), `file://${path}`], { encoding: "utf8", timeout: 15000 });
        assert.equal(browser.status, 0, browser.stderr);
        const json = browser.stdout.match(/<pre id="measurement"[^>]*>(.+?)<\/pre>/s)?.[1];
        assert.ok(json, "browser reports row measurements");
        const m = JSON.parse(json.replaceAll("&quot;", '"').replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">"));
        if (evidence) writeFileSync(join(evidence, `${name}.json`), JSON.stringify(m, null, 2));
        assert.equal(m.width, width);
        assert.equal(m.extraRows, 0, "no extra session-header notice row");
        assert.ok(m.row, "notice belongs to the count/title row");
        assert.ok(m.notice.top >= m.row.top && m.notice.bottom <= m.row.bottom, JSON.stringify(m));
        assert.ok(m.notice.width > 60 && Math.abs(m.notice.right - m.row.right) <= 12, JSON.stringify(m));
        assert.equal(m.dismissClickable, true);
        assert.equal(m.overflow, false);
        if (m.countsVisible) assert.ok(m.countsRight <= m.notice.left, "counts do not overlap the notice");
        if (macTitleBar) {
          assert.ok(m.notice.left >= 80, "traffic-light area remains clear");
          assert.equal(m.dragClickable, true, "spacer stays available for native dragging");
        }
      } finally { rmSync(temp, { recursive: true, force: true }); }
    });
  }
}
