import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";
import { build } from "vite";
import { renderNoticeSurface } from "./support/noticeSurfaces.ts";

let css: string;
before(async () => {
  const nodeEnv = process.env.NODE_ENV;
  const bundled = await build({ configFile: false, logLevel: "silent", plugins: [{
    name: "status-placement-css", resolveId(id) { if (id.endsWith("status-placement-css")) return "\0status-placement-css"; },
    load(id) { if (id === "\0status-placement-css") return 'import "/src/styles.css";'; },
  }], build: { write: false, lib: { entry: "status-placement-css", formats: ["es"] } } });
  if (nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = nodeEnv;
  const output = Array.isArray(bundled) ? bundled[0] : bundled;
  assert.ok(output && "output" in output);
  css = output.output.filter(item => item.type === "asset" && item.fileName.endsWith(".css")).map(item => String(item.source)).join("\n");
  assert.ok(css.length > 0, "use emitted production CSS including tokens and imports");
});

// Real Dashboard state and placement sites; transport, terminal and startup clock are synthetic.
for (const kind of ["host-offline", "attention", "info"] as const) {
  for (const [width, native] of (kind === "info" ? [[360, false]] : [[360, false], [412, false], [760, false], [761, false], [1280, true]]) as [number, boolean][]) {
    for (const focused of kind === "info" ? [true] : [false, true]) {
      for (const counts of width <= 760 && focused ? [true, false] : [true]) {
        test(`${kind} ${width}px ${native ? "native" : "web"} ${focused ? "focused" : "overview"} counts ${counts}`, async () => {
          const markup = await renderNoticeSurface("dashboard", width, { restore: false, focused, macTitleBar: native, phoneFocusCounts: counts,
            conversationUnavailable: kind === "info", focusedConversation: kind !== "info" && focused && width <= 760,
            error: kind === "host-offline" ? "very-long-production-machine-name: offline (cooling down after a failed probe)" : kind === "attention" ? "Session update needs attention" : undefined });
          const m = measure(markup, width, native, `${kind}-${width}-${native}-${focused}-${counts}`);
          if (width <= 760) {
            assert.ok(Math.abs(m.noticeHeight - m.rowHeight) <= 1, `notice height matches count row: ${JSON.stringify(m)}`);
            assert.ok(Math.abs(m.noticeCenter - m.rowCenter) <= 1, `notice is vertically centered: ${JSON.stringify(m)}`);
            assert.ok(m.dismissHeight >= 24 && m.dismissWidth >= 24, "preserve the existing 24px dismissal hit area");
            assert.equal(m.dismissEdgesClickable, true, "dismissal hit area remains reachable above and below its center");
          }
          assert.equal(m.notices, 1, "one notice at a time");
          assert.equal(m.extraRows, 0, "no extra row or conversation paragraph");
          assert.equal(m.inRow, true, "notice occupies the status-count row or title-bar end");
          assert.equal(m.floating, false, "no floating layer over the conversation");
          assert.equal(m.atEnd, true, "notice stays at the row's right end");
          assert.equal(m.dismissClickable, true, "dismiss button is reachable");
          assert.equal(m.overflow, false);
          if (width <= 760) assert.equal(m.fullVisible, true, "phone shows the full status message");
          assert.equal(m.role, kind === "info" ? "status" : "alert");
          assert.equal(m.rowHeight, m.clearRowHeight, "notice does not grow its row");
          if (width <= 760 && focused) {
            assert.equal(m.countsVisible, counts, "persistent counts remain visible beneath the notice");
            if (counts && width === 360 && kind === "host-offline") assert.equal(m.overlap, true, "long notice overlays counts");
          }
        });
      }
    }
  }
}

test("short phone host notice shows its full message beside enabled counts without reflow", async () => {
  const markup = await renderNoticeSurface("dashboard", 360, { restore: false, focused: true,
    machine: "fixture", error: "fixture: offline" });
  const m = measure(markup, 360, false, "host-short");
  assert.equal(m.fullVisible, true, "phone shows the full status message");
  assert.equal(m.fullMessage, "fixture: offline");
  assert.equal(m.countsVisible, true);
  assert.equal(m.overlap, false);
  assert.equal(m.rowHeight, m.clearRowHeight);
});

function measure(markup: string, width: number, native: boolean, name: string) {
  const temp = mkdtempSync(join(tmpdir(), "status-placement-"));
  const evidence = process.env.AGENT_CONSOLE_UI_SCREENSHOT_DIR;
  try {
    const frame = `<!doctype html><meta charset="utf-8"><html ${native ? 'data-mac-titlebar="true"' : ""}><style>${css}</style>${markup}<script>
      const pill=document.querySelector('.connection-notice'),layer=pill?.parentElement;
      const row=pill?.closest('${native ? ".mac-titlebar" : width <= 760 ? ".slot-focus-strip, .session-filter-status-row" : ".session-filter-trigger-row, .slot-head"}');
      const p=pill?.getBoundingClientRect(),r=row?.getBoundingClientRect();
      const counts=row?.querySelector('.session-status-counts'),c=counts?.getBoundingClientRect();
      const dismiss=pill?.querySelector('button'),d=dismiss?.getBoundingClientRect(),hit=d&&document.elementFromPoint(d.x+d.width/2,d.y+d.height/2);
      const rowHeight=r?.height; if(layer)layer.style.display='none';
      const clearRowHeight=row?.getBoundingClientRect().height; if(layer)layer.style.display='';
      const full=pill?.querySelector('.connection-notice-message-full'),fullStyle=full&&getComputedStyle(full);
      const result={fullVisible:!!fullStyle&&fullStyle.display!=='none'&&fullStyle.clipPath==='none'&&full.getBoundingClientRect().width>1,fullMessage:full?.textContent,notices:document.querySelectorAll('.connection-notice').length,
        extraRows:document.querySelectorAll('.slot-connection-row, .dash > p[role="status"]').length,
        inRow:!!r&&p.top>=r.top&&p.bottom<=r.bottom,
        floating:!row||getComputedStyle(layer).position==='fixed',
        atEnd:!!r&&Math.abs(p.right-r.right)<=12,
        countsVisible:!!c?.width&&getComputedStyle(counts).display!=='none',
        overlap:!!c?.width&&p.left<c.right,rowHeight,clearRowHeight,
        noticeHeight:p?.height,noticeCenter:p&&(p.top+p.bottom)/2,rowCenter:r&&(r.top+r.bottom)/2,
        dismissHeight:d?.height,dismissWidth:d?.width,
        dismissEdgesClickable:!!d&&[d.top+1,d.bottom-1].every(y=>{const h=document.elementFromPoint(d.x+d.width/2,y);return h===dismiss||dismiss.contains(h);}),
        dismissClickable:!!dismiss&&(hit===dismiss||dismiss.contains(hit)),role:pill?.getAttribute('role'),
        overflow:document.documentElement.scrollWidth>innerWidth};
      parent.document.querySelector('#measurement').textContent=JSON.stringify(result);
    </script></html>`;
    const path = join(temp, "fixture.html");
    writeFileSync(path, `<!doctype html><meta charset="utf-8"><style>body{margin:0}iframe{display:block;border:0}</style><iframe width="${width}" height="800"></iframe><pre id="measurement" hidden></pre><script>document.querySelector('iframe').srcdoc=${JSON.stringify(frame).replaceAll("<", "\\u003c")}</script>`);
    if (evidence) mkdirSync(evidence, { recursive: true });
    const browser = spawnSync(process.env.CHROME_BIN ?? "google-chrome", ["--headless", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
      `--window-size=${Math.max(width, 800)},850`, "--virtual-time-budget=3000", "--dump-dom",
      ...(evidence ? [`--screenshot=${join(evidence, `${name}.png`)}`] : []), `file://${path}`], { encoding: "utf8", timeout: 15000, maxBuffer: 16 * 1024 * 1024 });
    assert.equal(browser.status, 0, browser.stderr);
    const json = browser.stdout.match(/<pre id="measurement"[^>]*>(.+?)<\/pre>/s)?.[1];
    assert.ok(json, "browser reports measurements");
    const m = JSON.parse(json.replaceAll("&quot;", '"').replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">"));
    if (evidence) writeFileSync(join(evidence, `${name}.json`), JSON.stringify(m, null, 2));
    return m;
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
