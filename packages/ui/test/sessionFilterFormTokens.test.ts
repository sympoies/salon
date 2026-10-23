import { strict as assert } from "node:assert";
import { test } from "node:test";
import { uiStyles } from "./support/source.ts";

const styles = uiStyles();

test("Settings and mobile Session filters share the Settings form tokens", () => {
  const settingsField = /\.settings-field\s*\{([^}]*)\}/s.exec(styles)?.[1];
  const settingsSection = /\.settings-section\s*\{([^}]*)\}/s.exec(styles)?.[1];
  const controls = /input:where\([\s\S]*?\.select-menu-trigger\s*\{([^}]*)\}/s.exec(styles)?.[1];
  const mobileFields = /\.session-filter-panel\.is-mobile \.session-filter-panel-fields select,[\s\S]*?\{([^}]*)\}/s.exec(styles)?.[1];
  const mobilePanel = /\.session-filter-panel\.is-mobile\s*\{([^}]*)\}/s.exec(styles)?.[1];
  const mobileInset = /\.session-filter-panel\.is-mobile\s*\{[^}]*padding-inline:\s*var\(--form-horizontal-inset\)/s.exec(styles);

  assert.ok(settingsField, "Settings field styles exist");
  assert.ok(settingsSection, "Settings section styles exist");
  assert.ok(controls, "shared Settings form control styles exist");
  assert.ok(mobileFields, "mobile Session filters control styles exist");
  assert.ok(mobilePanel, "mobile Session filters sheet styles exist");

  assert.match(settingsField, /gap:\s*var\(--form-label-field-gap\)/);
  assert.match(settingsSection, /gap:\s*var\(--form-field-gap\)/);
  assert.match(settingsSection, /padding:\s*var\(--form-horizontal-inset\)/);
  assert.match(controls, /min-height:\s*var\(--form-field-height\)/);
  assert.match(controls, /font-size:\s*var\(--form-value-font-size\)/);
  assert.match(mobileFields, /min-height:\s*var\(--form-field-height\)/);
  assert.match(mobileFields, /font-size:\s*var\(--form-value-font-size\)/);
  assert.ok(mobileInset, "mobile sheet uses the Settings horizontal inset token");

  for (const token of [
    "--form-field-height",
    "--form-value-font-size",
    "--form-label-field-gap",
    "--form-field-gap",
    "--form-horizontal-inset",
  ]) {
    assert.equal(styles.match(new RegExp(`${token}:`, "g"))?.length, 1, `${token} has one shared definition`);
  }
});
