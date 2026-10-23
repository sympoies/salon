import { createElement } from "react";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createUiSsrHarness, renderComponent } from "./support/ssr.ts";
import { hasHeadlessChrome, measureUiMarkup } from "./support/browserLayout.ts";
import { makeSession, makeSessionSlotProps } from "./support/fixtures.ts";
import { CLEAR_SESSION_FILTERS } from "../src/sessionFilters.ts";

test("same-role icon controls share toolbar metrics in actual consumer contexts", async t => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const h = createUiSsrHarness([{
    name: "metrics-terminal", enforce: "pre",
    resolveId(id) { if (id.endsWith("TerminalPane.tsx")) return "\0metrics-terminal"; },
    load(id) { if (id === "\0metrics-terminal") return "export const TerminalPane=()=>null;"; },
  }]);
  try {
    const { SessionSlot } = await h.loadModule<typeof import("../src/SessionSlot.tsx")>("/src/SessionSlot.tsx");
    const { SessionFiltersBar } = await h.loadModule<typeof import("../src/SessionFiltersBar.tsx")>("/src/SessionFiltersBar.tsx");
    const { HeaderMenu } = await h.loadModule<typeof import("../src/HeaderMenu.tsx")>("/src/HeaderMenu.tsx");
    const { SessionCopyMenu } = await h.loadModule<typeof import("../src/SessionCopyMenu.tsx")>("/src/SessionCopyMenu.tsx");
    const { IconButton } = await h.loadModule<typeof import("../src/IconButton.tsx")>("/src/IconButton.tsx");
    const { ExtensionSettingsPanels, UiExtensionsProvider, createUiExtensionRegistry } = await h.loadModule<typeof import("../src/extensions.tsx")>("/src/extensions.tsx");
    const settingsRegistry = createUiExtensionRegistry([{ id: "fixture", settingsPanels: [{ id: "controls", render: () =>
      createElement("div", { className: "fixture-settings" }, ...["Drag item", "Move item up", "Move item down"].map(label => createElement(IconButton, { key: label, "aria-label": label }, "↑"))) }] }]);
    const SettingsControls = () => createElement(UiExtensionsProvider, { registry: settingsRegistry }, createElement(ExtensionSettingsPanels));
    const { LiveConversationPanel } = await h.loadModule<typeof import("../src/LiveConversationPanel.tsx")>("/src/LiveConversationPanel.tsx");
    const session = makeSession({ machine: "fixture-host", id: "metrics", title: "Fixture session" });
    const extraCss = ["sessionCardRows.css", "sessionCopyMenu.css"]
      .map(name => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8")).join("\n");
    for (const [width, coarse] of [[1280, false], [412, false], [412, true], [800, true], [1025, true]] as const) {
      await t.test(`${width}px ${coarse ? "touch" : "fine"}`, () => {
        const mobile = width <= 760 || (coarse && width <= 1024);
        const markup = `<style>${extraCss}</style>` +
          renderComponent(HeaderMenu, { open: false, onOpenChange() {}, historyAvailable: true, onHistory() {}, onUsage() {}, onDebug() {}, onSettings() {} }) +
          `<div class="session-workspace ${mobile ? "mobile" : "desktop"} is-focused">` +
          renderComponent(SessionSlot, makeSessionSlotProps({ session, options: [session], slot: "fixture-host/metrics", focused: true, viewport: { mobile }, sessionOrdinal: 1, sessionCount: 2, sessionNavList: [session] })) + `</div>` +
          renderComponent(SettingsControls, {}) +
          renderComponent(LiveConversationPanel, { session, onClose() {} }) +
          renderComponent(SessionCopyMenu, { actions: [], ariaLabel: "Copy fixture", title: "Copy fixture", mobile, open: false, copied: false, onOpenChange() {}, async onCopy() { return true; } }) +
          renderComponent(SessionFiltersBar, { filters: CLEAR_SESSION_FILTERS, machines: ["fixture-host"], roles: ["reviewer"], harnesses: [{ id: "codex", label: "Codex" }], resultCount: 1, mobile, open: true, onChange() {}, onOpenChange() {} });
        const m = measureUiMarkup<{ controls: Array<{ label: string; classes: string; width: number; height: number; padding: string; radius: string; glyph: number | null }> }>(markup, width, `
          const selector='summary.header-menu-trigger,.slot-open,.slot-refresh,.slot-action.danger,.agent-retitle-button,.session-command-copy-button,.session-filter-panel-heading button,.fixture-settings .control-icon,.conversation-head-actions .control-icon';
          const controls=[...document.querySelectorAll(selector)].map(b=>{const r=b.getBoundingClientRect(),s=getComputedStyle(b),g=b.querySelector('svg,.copy-icon');return {label:b.getAttribute('aria-label'),classes:String(b.className),width:r.width,height:r.height,padding:s.padding,radius:s.borderRadius,glyph:g?.getBoundingClientRect().width??null};});
          const result={controls};`, false, 1000, coarse ? ["--blink-settings=primaryPointerType=2,availablePointerTypes=2"] : []);
        assert.ok(m.controls.length >= 5, "real consumers are present");
        const size = mobile || coarse ? 40 : 34;
        for (const control of m.controls) {
          const paneOrCard = ["slot-open", "slot-refresh", "slot-action danger", "agent-retitle-button", "session-command-copy-button"].some(role => control.classes.includes(role));
          const expectedSize = paneOrCard ? mobile || coarse ? 34 : 30 : size;
          assert.equal(control.width, expectedSize, `${control.label}: shared family width`);
          assert.equal(control.height, expectedSize, `${control.label}: shared family height`);
          assert.equal(control.padding, "0px", `${control.label}: zero padding`);
          assert.equal(control.radius, "8px", `${control.label}: shared radius`);
          if (control.glyph !== null) assert.equal(control.glyph, control.label?.startsWith("Retitle") ? 16 : 18, `${control.label}: family glyph`);
        }
      });
    }
  } finally { await h.close(); }
});

test("shared menu, chip and terminal-key presets keep their role metrics", t => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const extraCss = readFileSync(new URL("../src/sessionCopyMenu.css", import.meta.url), "utf8");
  const markup = `<style>${extraCss}</style>
    <div class="header-menu-dropdown"><button class="control-menu header-menu-item">Settings</button></div>
    <div class="slot-title-dropdown"><button class="control-menu slot-menu-item">Open session</button></div>
    <div class="session-copy-menu"><button class="control-menu">Copy session</button></div>
    <button class="control-chip btn session-filter-chip">A filter</button>
    <button class="control-chip control-chip--dense btn session-filter-chip">A dense filter</button>
    <button class="control-key key">Tab</button>
    <button class="control-key key upload-key">Upload</button>
    <button class="control-key key voice-key">Voice</button>`;
  for (const [width, coarse] of [[1280, false], [412, true]] as const) {
    const m = measureUiMarkup<{ menus: Array<{ height: number; font: string; padding: string; radius: string }>; chips: number[]; keys: number[]; keyHeights: number[] }>(markup, width, `
      const box=e=>e.getBoundingClientRect();
      const menus=[...document.querySelectorAll('.control-menu')].map(e=>{const s=getComputedStyle(e);return {height:box(e).height,font:s.fontSize,padding:s.padding,radius:s.borderRadius};});
      const result={menus,chips:[...document.querySelectorAll('.control-chip')].map(e=>box(e).height),keys:[...document.querySelectorAll('.control-key')].map(e=>box(e).width),keyHeights:[...document.querySelectorAll('.control-key')].map(e=>box(e).height)};
    `, false, 800, coarse ? ["--blink-settings=primaryPointerType=2,availablePointerTypes=2"] : []);
    assert.equal(m.menus.length, 3);
    assert.equal(new Set(m.menus.map(row => JSON.stringify(row))).size, 1, "same-role menu metrics agree across consumers");
    assert.equal(m.menus[0]!.height, coarse ? 48 : 34);
    assert.deepEqual(m.chips, coarse ? [48, 30] : [34, 24], "regular and dense chips use their named presets");
    assert.deepEqual(m.keys, [46, 70, 82], "Upload and Voice retain their distinct key minima");
    assert.deepEqual(m.keyHeights, [42, 42, 42]);
  }
});
