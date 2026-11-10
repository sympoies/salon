import { strict as assert } from "node:assert";
import { test } from "node:test";
import { measureUiMarkup } from "./support/browserLayout.ts";

for (const view of ["local", "shared"] as const) for (const [width, container] of [[360, "phone-conversation-pane"], [390, "phone-conversation-pane"], [412, "phone-conversation-pane"], [1280, "slot-conversation-pane"], [1280, "conversation-dock"], [1280, ""]] as const) {
  test(`refused ${view} reply aligns with history at ${width}px in ${container || "viewer"}`, () => {
    const shared = view === "shared";
    const markup = `<style>html,body{margin:0}.history-messages{height:500px;box-sizing:border-box}</style><div class="${container}"><div class="history-viewer"><div class="history-messages">
      <article class="history-message is-user"><div class="history-bubble" id="history">Earlier reply</div></article></div>
      <section class="history-outgoing ${shared ? "history-shared-outgoing" : ""}"><article class="history-message is-user history-outgoing-reply"><div class="history-outgoing-body">
      <div class="history-bubble history-outgoing-bubble">A synthetic refused reply</div>
      <p class="history-outgoing-note">Terminal has a draft, so this reply was not sent. Clear it in the terminal, then Retry.${shared ? "" : '<button class="btn ghost">Retry</button><button class="btn ghost">Discard</button>'}</p>
      ${shared ? '<div class="history-outgoing-actions"><button class="btn ghost">Discard</button><button class="btn ghost">Retry</button></div>' : ""}
      </div></article></section></div></div>`;
    const m = measureUiMarkup<{ history: number; bubble: number; note: number; buttons: number[] }>(markup, width, `
      const inset = el => innerWidth - el.getBoundingClientRect().right;
      const result = {history:inset(document.querySelector('#history')), bubble:inset(document.querySelector('.history-outgoing-bubble')), note:inset(document.querySelector('.history-outgoing-note')), buttons:[...document.querySelectorAll('.history-outgoing button')].map(inset)};
    `, false, 800, process.env.AGENT_CONSOLE_UI_SCREENSHOT_DIR ? [`--screenshot=${process.env.AGENT_CONSOLE_UI_SCREENSHOT_DIR}/${view}-${width}.png`] : []);
    assert.ok(m.history > 0, JSON.stringify(m));
    assert.equal(m.bubble, m.history, JSON.stringify(m));
    assert.equal(m.note, m.history, JSON.stringify(m));
    assert.ok(m.buttons.every(inset => inset >= m.history), JSON.stringify(m));
    assert.ok(m.buttons.some(inset => inset === m.history), JSON.stringify(m));
  });
}
