import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import react from "@vitejs/plugin-react";
import { build } from "vite";
import { launchPage } from "./support/browserPage.ts";

const longMessage = "A long status message that cannot fit in the available notice space and should show its full details when opened.";

const fixture = `import React from 'react';
import {createRoot} from 'react-dom/client';
import {StatusNotice} from '/src/StatusNotice.tsx';
import '/src/styles.css';
const message = location.hash === '#short' ? 'Ready' : ${JSON.stringify(longMessage)};
const root = createRoot(document.getElementById('root'));
window.renderNotice = (kind, inline) => root.render(React.createElement(StatusNotice,{inline,notice:{kind,message},onDismiss(){}}));
window.renderNotice('attention', true);`;

test("notice disclosure follows clipping and keyboard focus", async t => {
  const dir = mkdtempSync(join(tmpdir(), "notice-disclosure-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bundle = await build({root:new URL("..", import.meta.url).pathname, configFile:false, logLevel:"silent", resolve:{conditions:["source"]},
    define:{"process.env.NODE_ENV":JSON.stringify("production")}, plugins:[react(), {name:"notice-fixture", resolveId(id) { if (id.endsWith("notice-fixture")) return "\0notice-fixture"; }, load(id) { if (id === "\0notice-fixture") return fixture; }}],
    build:{write:false,lib:{entry:"notice-fixture",name:"NoticeFixture",formats:["iife"]}}});
  const output = Array.isArray(bundle) ? bundle[0] : bundle;
  assert.ok(output && "output" in output);
  const code = output.output.filter(item => item.type === "chunk").map(item => item.code).join("\n");
  const css = output.output.filter(item => item.type === "asset" && item.fileName.endsWith(".css")).map(item => String(item.source)).join("\n");
  const page = await launchPage();
  t.after(() => page.close());
  for (const width of [390, 1280]) for (const theme of ["paper", "dark"]) {
    await page.setViewport(width, 800, 1, width === 390);
    const file = join(dir, `${width}-${theme}.html`);
    writeFileSync(file, `<!doctype html><html data-theme="${theme}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css} #root{width:200px}.connection-notice-layer{position:relative!important;transform:none!important}.connection-notice{max-width:100%}</style><div id="root" class="session-filter-trigger-row"></div><script>${code}</script>`);
    await page.navigate(pathToFileURL(file).href);
    await page.evaluate("new Promise(resolve => setTimeout(resolve, 150))");
    const evidence = process.env.SALON_UI_EVIDENCE_DIR;
    if (evidence) {
      mkdirSync(evidence, { recursive: true });
      writeFileSync(join(evidence, `${width}-${theme}.png`), await page.screenshot());
    }
    if (process.env.SALON_UI_CAPTURE_ONLY) {
      await page.pressTab();
      if (evidence) writeFileSync(join(evidence, `${width}-${theme}-focus.png`), await page.screenshot());
      await page.pressEnter();
      if (evidence) writeFileSync(join(evidence, `${width}-${theme}-open.png`), await page.screenshot());
      continue;
    }
    const state = await page.evaluate(`(() => { const b=document.querySelector('.connection-notice-trigger'); return {button:!!b, cue:!!b?.querySelector('.connection-notice-cue') && getComputedStyle(b.querySelector('.connection-notice-cue')).transform === 'none', decoration:b && getComputedStyle(b).textDecorationLine}; })()`);
    assert.deepEqual(state, {button:true,cue:true,decoration:"none"}, `${width} ${theme} clipped`);
    assert.equal(await page.accessibilityTextCount(longMessage), 1, "clipped notice is announced once");
    assert.deepEqual(await page.evaluate(`(() => { const cue=document.querySelector('.connection-notice-cue'), notice=cue.closest('.connection-notice'), dismiss=notice.querySelector('.connection-notice-dismiss'); const c=cue.getBoundingClientRect(), n=notice.getBoundingClientRect(), d=dismiss.getBoundingClientRect(); return {tone:getComputedStyle(cue).color===getComputedStyle(notice).color, inside:c.right<=n.right, width:d.width, height:d.height}; })()`), {tone:true,inside:true,width:16,height:16}, "cue stays inside the notice and dismiss remains usable");
    await page.evaluate(`(() => { const root=document.querySelector('#root'), message=document.querySelector('.connection-notice-message'), full=message.querySelector('.connection-notice-message-full'); root.style.width = (root.clientWidth + full.scrollWidth - message.clientWidth - 4) + 'px'; })()`);
    await page.evaluate("new Promise(resolve => setTimeout(resolve, 200))");
    assert.equal(await page.evaluate("!!document.querySelector('.connection-notice-trigger')"), true, "slightly clipped text stays expandable");
    await page.evaluate("document.querySelector('#root').style.width = '1400px'");
    await page.evaluate("new Promise(resolve => setTimeout(resolve, 100))");
    assert.equal(await page.evaluate("!!document.querySelector('.connection-notice-trigger')"), false, "resizing to fit removes the disclosure");
    await page.evaluate("document.querySelector('#root').style.width = '200px'");
    await page.evaluate("new Promise(resolve => setTimeout(resolve, 100))");
    await page.pressTab();
    assert.equal(await page.evaluate("getComputedStyle(document.querySelector('.connection-notice-trigger')).outlineWidth"), "2px", "keyboard focus uses the notice focus ring");
    const point = await page.evaluate<[number, number]>("(() => { const r = document.querySelector('.connection-notice-trigger').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()");
    await page.tap(...point);
    assert.equal(await page.evaluate("document.querySelector('.connection-notice-trigger').getAttribute('aria-expanded') === 'true' && getComputedStyle(document.querySelector('.connection-notice-cue')).transform !== 'none' && !!document.querySelector('.connection-notice-detail')"), true);
    await page.evaluate("document.querySelector('#root').style.width = '1400px'");
    await page.evaluate("new Promise(resolve => setTimeout(resolve, 100))");
    assert.equal(await page.evaluate("!document.querySelector('.connection-notice-trigger') && !document.querySelector('.connection-notice-detail')"), true, "resizing an open notice closes its details");
    await page.evaluate("document.querySelector('#root').style.width = '200px'");
    await page.evaluate("new Promise(resolve => setTimeout(resolve, 100))");
    assert.equal(await page.evaluate("document.querySelector('.connection-notice-trigger').getAttribute('aria-expanded') === 'false'"), true);
    await page.pressTab();
    await page.pressEnter();
    await page.pressEscape();
    assert.equal(await page.evaluate("document.querySelector('.connection-notice-trigger').getAttribute('aria-expanded') === 'false'"), true);
    await page.evaluate("window.renderNotice('host-offline', false)");
    await page.evaluate("new Promise(resolve => setTimeout(resolve, 100))");
    await page.evaluate("document.querySelector('.connection-notice-trigger').click()");
    await page.evaluate("window.renderNotice('unreachable', false)");
    await page.evaluate("new Promise(resolve => setTimeout(resolve, 100))");
    await page.evaluate("window.renderNotice('host-offline', false)");
    await page.evaluate("new Promise(resolve => setTimeout(resolve, 100))");
    assert.equal(await page.evaluate("document.querySelector('.connection-notice-trigger').getAttribute('aria-expanded') === 'false' && !document.querySelector('.connection-notice-detail')"), true, "changing notice kind clears the open state");
    await page.navigate(`${pathToFileURL(file).href}?short#short`);
    await page.evaluate("new Promise(resolve => setTimeout(resolve, 150))");
    assert.equal(await page.evaluate("!!document.querySelector('.connection-notice-trigger')"), false, `${width} ${theme} short`);
    assert.equal(await page.accessibilityTextCount("Ready"), 1, "short notice is announced once");
    await page.evaluate("document.querySelector('#root').style.width = '135px'");
    await page.evaluate("new Promise(resolve => setTimeout(resolve, 100))");
    assert.equal(await page.evaluate("!!document.querySelector('.connection-notice-trigger')"), false, `${width} ${theme} short at compact width`);
  }
});
