import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import react from "@vitejs/plugin-react";
import { build } from "vite";
import { launchPage } from "./support/browserPage.ts";

const message = "Sample host: the connection is unavailable. Reconnect to the host to continue working in this session.";
const filename = `project-notes-${"appendix-".repeat(12)}final.pdf`;
const account = `sample-${"team-".repeat(10)}member@example.test`;
const sessionId = `sample-session-${"1234567890".repeat(8)}`;
const path = `/example/projects/${"documentation-".repeat(8)}/sample`;
const filter = `example-${"workspace-".repeat(8)}`;
const model = `sample-${"model-".repeat(8)}`;
const settingsCallbacks = [
  "onSaved", "onMachineColorChange", "onMachineColorReset", "onMachineOrderChange",
  "onMachineOrderRestore", "onDefaultAutoResumeChange", "onAttentionAlertsChange",
  "onTerminalRenderModeChange", "onTerminalSelectedPaneRealtimeChange", "onSignedOut",
];

const fixture = `
  import React, { useState } from 'react';
  import { createRoot } from 'react-dom/client';
  import { StatusNotice } from '/src/StatusNotice.tsx';
  import { ProviderCard } from '/src/UsagePanel.tsx';
  import { ComposerAttachment } from '/src/ComposerAttachment.tsx';
  import { AttachmentFileCard } from '/src/AttachmentFileCard.tsx';
  import { HistoryPanel } from '/src/HistoryPanel.tsx';
  import { SessionFiltersBar } from '/src/SessionFiltersBar.tsx';
  import { CLEAR_SESSION_FILTERS } from '/src/sessionFilters.ts';
  import { TerminalView } from '/src/TerminalView.tsx';
  import { LiveConversationPanel } from '/src/LiveConversationPanel.tsx';
  import { LayoutPicker } from '/src/LayoutPicker.tsx';
  import { Settings } from '/src/Settings.tsx';
  import { SessionActivityPopover } from '/src/SessionActivityPopover.tsx';
  import { makeSession } from '/test/support/fixtures.ts';
  import '/src/styles.css';

  const h = React.createElement, noop = () => {};
  const key = location.hash.slice(1);
  const attachment = {path:'/example/uploads/stored.pdf',original_name:${JSON.stringify(filename)},bytes:2048};
  const settingsCallbacks = Object.fromEntries(${JSON.stringify(settingsCallbacks)}.map(key => [key, noop]));
  const filters = {...CLEAR_SESSION_FILTERS, workspaces:[${JSON.stringify(filter)},'another-workspace']};
  function Overview() {
    const [show, setShow] = useState(true);
    return h(SessionFiltersBar,{mobile:true,compactHeader:true,filters,records:[],workspaceChoicesComplete:false,machines:['sample-host'],
      harnesses:[{id:'codex',label:'Codex'}],onChange:noop,resultCount:0,
      statusNotice:show ? h(StatusNotice,{inline:true,notice:{kind:'host-offline',message:${JSON.stringify(message)}},onDismiss:()=>setShow(false)}) : null});
  }
  function Dock() {
    const [pinned, setPinned] = useState(true);
    return h(LiveConversationPanel,{session:makeSession(),docked:true,onClose:noop,pinned,onTogglePin:()=>setPinned(!pinned)});
  }
  const views = {
    conversation:h(Dock),
    overview:h(Overview),
    history:h(HistoryPanel,{machines:['sample-host'],onClose:noop,onResumed:noop}),
    usage:h('ul',{className:'usage-providers'},h(ProviderCard,{now:0,provider:{
      ok:true,provider:'claude',label:'Claude',plan:null,account:${JSON.stringify(account)},switch_key:'Example team',windows:[]}})),
    attachments:h(React.Fragment,null,h(ComposerAttachment,{attachment,disabled:false,onRemove:noop}),
      h('div',{className:'attachment-file-list'},h(AttachmentFileCard,{attachment,file:{path:attachment.path}}))),
    settings:h(Settings,{...settingsCallbacks,variant:'manage',machines:['sample-host'],machineColors:{'sample-host':'#123456'},
      defaultAutoResume:false,attentionAlerts:false,terminalRenderMode:'realtime',terminalSelectedPaneRealtime:true,machineOrderSaved:true,openAccess:true}),
    terminal:h(TerminalView,{machine:'sample-host',id:'sample-terminal',title:'Sample terminal',titleRevision:0,
      sessionIncarnation:'sample-launch',onExit:noop}),
    layout:h('div',{className:'workspace-head',style:{display:'flex',justifyContent:'flex-end'}},h('div',{className:'dash-create-actions'},
      h(LayoutPicker,{auto:true,mode:1,displayedMode:2,onToggleAuto:noop,onSelect:noop}))),
    activity:h(SessionActivityPopover,{session:makeSession({model:${JSON.stringify(model)},reasoning_effort:'high',
      context_usage:{used_tokens:12345,window_tokens:200000,source:'codex-rollout',observed_at:'2026-01-01T12:00:00Z'}}),machineReachable:true,focused:false,nowMs:0}),
  };
  createRoot(document.querySelector('#root')).render(views[key]);
`;

test("full details are readable on a touch-width viewport", async t => {
  const dir = mkdtempSync(join(tmpdir(), "salon-touch-hints-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bundle = await build({
    root: new URL("..", import.meta.url).pathname, configFile: false, logLevel: "silent", resolve: { conditions: ["source"] },
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [react(), {
      name: "touch-title-hints-fixture",
      enforce: "pre",
      resolveId(id, importer) {
        if (id === "./terminalInstance.ts" && importer?.endsWith("/src/TerminalPane.tsx")) return "\0touch-title-terminal";
        if (id.endsWith("touch-title-hints-fixture")) return "\0touch-title-hints-fixture";
      },
      load(id) {
        if (id === "\0touch-title-hints-fixture") return fixture;
        if (id === "\0touch-title-terminal") return `
          export const BASE_TERMINAL_FONT_SIZE = 14;
          export function createTerminalInstance(_host, deps) {
            deps.setStatus("open");
            window.openTerminalMenu = () => deps.setTerminalTouchMenu({key:deps.terminalInstanceKey,
              x:8,y:80,width:340,hasSelection:false,linkUrl:null,
              links:[{url:"https://example.test/docs/" + "long-segment-".repeat(8),label:"Sample documentation"}]});
            return () => {};
          }`;
      },
    }],
    build: { write: false, lib: { entry: "touch-title-hints-fixture", name: "TouchHintsFixture", formats: ["iife"] } },
  });
  const output = Array.isArray(bundle) ? bundle[0] : bundle;
  assert.ok(output && "output" in output);
  const code = output.output.filter(item => item.type === "chunk").map(item => item.code).join("\n");
  const css = output.output.filter(item => item.type === "asset" && item.fileName.endsWith(".css")).map(item => String(item.source)).join("\n");
  const page = await launchPage();
  t.after(() => page.close());
  await page.setViewport(390, 844, 1, true);
  await page.addInitScript(`
    window.fetch = async url => {
      const sessions = [{id:"example-history",machine:"sample-host",provider:"codex",provider_session_id:${JSON.stringify(sessionId)},
        cwd:${JSON.stringify(path)},title:"Sample conversation",resumable:false,created_at:"2026-01-01T12:00:00Z",updated_at:"2026-01-01T12:00:00Z"}];
      if (String(url).includes('/api/history/sessions?')) return Response.json({ok:true,data:{sessions}});
      return Response.json({ok:true,data:{messages:[]}});
    };`);
  const evidence = process.env.SALON_UI_EVIDENCE_DIR;
  if (evidence) mkdirSync(evidence, { recursive: true });
  const save = async (theme: string, name: string) => {
    if (evidence) writeFileSync(join(evidence, `${theme}-${name}.png`), await page.screenshot());
  };
  const wait = (selector: string) => page.evaluate(`(async () => {
    const deadline = performance.now() + 4000;
    while (!document.querySelector(${JSON.stringify(selector)})) {
      if (performance.now() > deadline) throw Error("Missing fixture element " + ${JSON.stringify(selector)});
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  })()`);
  const tap = async (selector: string) => {
    const point = await page.evaluate<[number, number] | null>(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return null;
      node.scrollIntoView({block:"nearest"});
      const r = node.getBoundingClientRect();
      return [r.x + r.width / 2, r.y + r.height / 2];
    })()`);
    if (point) await page.tap(...point);
    return point !== null;
  };
  const readable = (selector: string, value: string) => page.evaluate<boolean>(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node?.innerText.includes(${JSON.stringify(value)})) return false;
    const box = node.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && box.left >= 0 && box.right <= innerWidth
      && node.scrollWidth <= node.clientWidth + 1 && getComputedStyle(node).whiteSpace !== "nowrap";
  })()`);
  for (const theme of ["paper", "dark"]) {
    const run = (view: string, check: () => Promise<void>) => t.test(`${theme} ${view}`, async () => {
      const file = join(dir, `${theme}-${view}.html`);
      writeFileSync(file, `<!doctype html><html data-theme="${theme}" data-phone-tier="true" data-phone-header="true" data-android-desktop="true">
        <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <style>${css} #root{padding:12px} .session-filter-status-row{height:34px;position:relative}</style>
        <div id="root"></div><script>localStorage.setItem("ac.themeMode", ${JSON.stringify(theme)});</script>
        <script>${code.replaceAll("</script", "<\\/script")}</script>`);
      await page.navigate(`${pathToFileURL(file).href}#${view}`);
      await check();
    });
    await run("overview", async () => {
      await wait(".connection-notice");
      const trigger = 'button[aria-label="Show status notice details"]';
      await tap(trigger);
      await save(theme, "notice");
      const showsFullMessage = await readable(".connection-notice-detail", message);
      if (showsFullMessage) {
        await page.pressEscape();
        assert.equal(await page.evaluate(`document.activeElement.matches('${trigger}') && !document.querySelector('.connection-notice-detail')`), true);
      }
      await tap(".session-filter-search-open");
      await wait(".session-filter-panel");
      await save(theme, "filters");
      assert.equal(showsFullMessage, true, "pressing the notice shows the complete message");
      assert.equal(await readable(".session-filter-panel .session-filter-chip-label", `${filter}, another-workspace`), true);
    });
    await run("history", async () => {
      await wait(".history-row");
      await tap(".history-row");
      await wait(".history-session-id");
      await save(theme, "history");
      assert.equal(await readable(".history-viewer-meta .history-project-path", path), true);
      assert.equal(await readable(".history-session-id", sessionId), true, "full provider session ID wraps in History");
    });
    await run("usage", async () => {
      await wait(".usage-provider");
      await save(theme, "usage");
      assert.equal(await readable(".usage-provider-account-detail", account), true, "account card shows the identity behind the alias");
      assert.equal(await page.evaluate("document.querySelector('.usage-plan-unknown')?.innerText"), "Plan unavailable");
    });
    await run("attachments", async () => {
      await wait(".file-card");
      await save(theme, "attachments");
      assert.equal(await readable(".composer-attachment-name", filename), true, "composer shows the full filename");
      assert.equal(await readable(".file-card-name", filename), true, "sent file card shows the full filename");
    });
    await run("settings", async () => {
      await wait(".settings-color-input");
      await page.evaluate("document.querySelector('.settings-color-input').scrollIntoView({block:'center'})");
      await save(theme, "settings");
      assert.equal(await page.evaluate("document.documentElement.dataset.theme"), theme);
      assert.equal(await readable(".settings-color-value", "#123456"), true, "machine colour value is visible beside the swatch");
    });
    await run("conversation", async () => {
      await wait(".conversation-pin");
      await save(theme, "conversation");
      const pinnedText = await page.evaluate("document.querySelector('.conversation-head p')?.innerText");
      await tap(".conversation-pin");
      assert.match(pinnedText ?? "", /Pinned to this session/);
      assert.match(await page.evaluate<string>("document.querySelector('.conversation-head p')?.innerText"), /Following selected session/);
    });
    await run("terminal", async () => {
      await wait(".terminal-pane");
      await page.evaluate("window.openTerminalMenu()");
      await wait(".terminal-touch-menu");
      await save(theme, "terminal-actions");
      const copyText = await page.evaluate("document.querySelector('.terminal-touch-menu button')?.innerText");
      await tap(".terminal-touch-menu button:nth-child(3)");
      await wait(".terminal-link-picker-url");
      await save(theme, "terminal-links");
      assert.equal(await readable(".terminal-link-picker-url", "https://example.test/docs/" + "long-segment-".repeat(8)), true);
      assert.equal(copyText, "Copy last", "the toolbar distinguishes fallback copy scope");
      assert.equal(await page.evaluate("document.querySelector('.term-connection-status')?.innerText"), "Connected");
    });
    await run("layout", async () => {
      await wait(".layout-picker-trigger");
      await tap(".layout-picker-trigger");
      await wait(".layout-picker-option");
      await save(theme, "layout");
      assert.equal(await readable(".layout-picker-option-description", "Follows session count"), true);
    });
    await run("activity", async () => {
      await wait(".session-activity-trigger");
      await tap(".session-activity-trigger");
      await wait(".session-activity-popover.is-pinned");
      await save(theme, "activity");
      const runtime = '.session-activity-group:last-child';
      assert.equal(await readable(runtime, model), true, "session popover shows the full model");
      assert.equal(await readable(runtime, "12,345 / 200,000 tokens"), true, "session popover shows exact token counts");
    });
  }
});
