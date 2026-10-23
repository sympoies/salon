import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { makeSession } from "./support/fixtures.ts";
import { createUiSsrHarness } from "./support/ssr.ts";
import { hasHeadlessChrome, measureUiMarkup } from "./support/browserLayout.ts";

interface FontMeasurement {
  coarse: boolean;
  fields: Array<{ initial: string; placeholder: string; typed: string; focused: boolean }>;
}

for (const coarse of [false, true]) for (const width of [390, 1500]) {
  test(`composer typography matches across tile/dock/phone before and after typing (${coarse ? "coarse" : "fine"}, ${width}px)`, async t => {
    if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
    const harness = createUiSsrHarness();
    try {
      const { ConversationComposer } = await harness.loadModule<typeof import("../src/ConversationComposer.tsx")>("/src/ConversationComposer.tsx");
      const composer = renderToStaticMarkup(createElement(ConversationComposer, {
        session: makeSession(), machineReachable: true, onBusyChange() {}, onVoiceOpenChange() {},
      }));
      const markup = ["slot-conversation-pane", "conversation-dock", "phone-conversation-pane"]
        .map(className => `<section class="${className}" style="position:static;width:100%;height:180px">${composer}</section>`).join("");
      const result = measureUiMarkup<FontMeasurement>(markup, width, `
        const fields=[...document.querySelectorAll('textarea')].map(node=>{
          const initial=getComputedStyle(node).fontSize;
          const placeholder=getComputedStyle(node,'::placeholder').fontSize;
          node.focus();node.value='A typed reply';node.dispatchEvent(new Event('input',{bubbles:true}));
          return{initial,placeholder,typed:getComputedStyle(node).fontSize,focused:document.activeElement===node};
        });
        const result={coarse:matchMedia('(pointer: coarse)').matches,fields};
      `, false, 800, coarse ? ["--blink-settings=primaryPointerType=2,availablePointerTypes=2"] : []);
      assert.equal(result.coarse, coarse, "the browser uses the requested pointer context");
      assert.equal(result.fields.length, 3, "real shared composer markup is present in each consumer wrapper");
      assert.equal(new Set(result.fields.map(field => field.initial)).size, 1,
        `tile, dock and phone composer font sizes must match: ${result.fields.map(field => field.initial).join(", ")}`);
      for (const field of result.fields) {
        assert.equal(field.placeholder, field.initial);
        assert.equal(field.typed, field.initial, "focus and typing never enlarge the font");
        assert.equal(field.focused, true);
        if (coarse) assert.ok(parseFloat(field.typed) >= 16, "touch fields retain the focus-zoom prevention floor");
      }
    } finally { await harness.close(); }
  });
}
