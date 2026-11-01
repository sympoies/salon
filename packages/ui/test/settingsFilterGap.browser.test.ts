import { strict as assert } from "node:assert";
import { test } from "node:test";
import { CLEAR_SESSION_FILTERS } from "../src/sessionFilters.ts";
import { hasHeadlessChrome, measureUiMarkup } from "./support/browserLayout.ts";
import { createUiSsrHarness, renderComponent } from "./support/ssr.ts";

test("modal Settings and mobile Session filters have equal computed label-to-field gaps", async t => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const harness = createUiSsrHarness();
  try {
    const { Settings } = await harness.loadModule<typeof import("../src/Settings.tsx")>("/src/Settings.tsx");
    const { SessionFiltersBar } = await harness.loadModule<typeof import("../src/SessionFiltersBar.tsx")>("/src/SessionFiltersBar.tsx");
    const settings = renderComponent(Settings, {
      machines: [], machineColors: {}, defaultAutoResume: false, attentionAlerts: false,
      pinCoordinators: false, terminalRenderMode: "realtime", terminalSelectedPaneRealtime: true,
      openAccess: true, onSaved() {}, onMachineColorChange() {}, onMachineColorReset() {},
      onDefaultAutoResumeChange() {}, onAttentionAlertsChange() {}, onPinCoordinatorsChange() {},
      onTerminalRenderModeChange() {}, onTerminalSelectedPaneRealtimeChange() {}, onSignedOut() {},
    });
    const filters = renderComponent(SessionFiltersBar, {
      filters: CLEAR_SESSION_FILTERS, machines: ["fixture-machine"], harnesses: [], resultCount: 1,
      mobile: true, open: true, onChange() {}, onOpenChange() {},
    });
    for (const width of [360, 412]) {
      const result = measureUiMarkup<{
        settingsGap: number; filterGap: number; settingsGeometry: number; filterGeometry: number;
        genericGap: number; speechGap: number; settingsHeight: number; filterHeight: number; settingsFont: number; filterFont: number;
      }>(`<div class="modal">${settings}<label class="generic-modal-field"><span>Generic</span><input></label></div><div class="modal speech-modal"><label><span>Language</span><select><option>Automatic</option></select></label></div>${filters}`, width, `
        const settings=document.querySelector('.settings-field');
        const filter=document.querySelector('.session-filter-panel-fields > label');
        const settingsControl=settings.querySelector('select'),filterControl=filter.querySelector('input[type="search"]');
        const range=document.createRange();range.selectNodeContents(settings.firstChild);
        const settingsLabel=range.getBoundingClientRect(),filterLabel=filter.querySelector('span').getBoundingClientRect();
        const result={settingsGap:parseFloat(getComputedStyle(settings).rowGap),filterGap:parseFloat(getComputedStyle(filter).rowGap),
          settingsGeometry:settingsControl.getBoundingClientRect().top-settingsLabel.bottom,
          filterGeometry:filterControl.getBoundingClientRect().top-filterLabel.bottom,
          genericGap:parseFloat(getComputedStyle(document.querySelector('.generic-modal-field')).rowGap),
          speechGap:parseFloat(getComputedStyle(document.querySelector('.speech-modal label')).rowGap),
          settingsHeight:settingsControl.getBoundingClientRect().height,filterHeight:filterControl.getBoundingClientRect().height,
          settingsFont:parseFloat(getComputedStyle(settingsControl).fontSize),filterFont:parseFloat(getComputedStyle(filterControl).fontSize)};
      `);
      assert.equal(result.settingsGap, result.filterGap, `${width}px computed label gaps match: ${JSON.stringify(result)}`);
      assert.equal(result.settingsGap, 6, "both fields retain the shared 6px token");
      assert.ok(Math.abs(result.settingsGeometry - result.filterGeometry) <= 1, "visible label-to-field gaps match within 1px");
      assert.equal(result.genericGap, 4, "other modal labels retain their existing gap");
      assert.equal(result.speechGap, 6, "component-specific modal spacing retains its original specificity");
      assert.ok(result.settingsHeight > 0);
      assert.equal(result.settingsHeight, result.filterHeight, "shared field heights still match");
      assert.equal(result.settingsFont, 16);
      assert.equal(result.filterFont, 16);
    }
  } finally { await harness.close(); }
});
