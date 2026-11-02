import { strict as assert } from "node:assert";
import { test } from "node:test";
import { hasHeadlessChrome, measureUiMarkup } from "./support/browserLayout.ts";

interface Marker { readonly right: boolean; readonly down: boolean; readonly open: boolean }
interface Measurement { readonly collapsed: Marker; readonly expanded: Marker; readonly toggled: Marker; readonly keyboard: Marker; readonly otherNotice: string }

const row = (open: boolean, id: string) => `<div class="session-notice mailbox-event"><details id="${id}" class="mailbox-event-disclosure"${open ? " open" : ""}>
  <summary><span class="session-notice-label">Mailbox</span><span class="mailbox-event-from">sender · host</span><span class="mailbox-event-state">Read</span></summary>
  <div class="mailbox-event-body">Body</div></details></div>`;
const markup = `${row(false, "closed")}${row(true, "start-open")}<div class="session-notice"><h3 class="session-notice-title">Notice</h3></div>`;
// A visible triangle is drawn on the one side that points: right = the left border, down = the top border.
const script = `
  const marker = id => { const d = document.getElementById(id); const s = getComputedStyle(d.querySelector('summary'), '::before');
    const visible = value => value !== 'rgba(0, 0, 0, 0)' && value !== 'transparent';
    return { right: visible(s.borderLeftColor) && s.borderLeftWidth !== '0px', down: visible(s.borderTopColor) && s.borderTopWidth !== '0px', open: d.open }; };
  const result = { collapsed: marker('closed'), expanded: marker('start-open') };
  document.querySelector('#closed summary').click(); result.toggled = marker('closed');
  document.querySelector('#closed summary').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
  document.querySelector('#closed summary').click(); result.keyboard = marker('closed');
  result.otherNotice = getComputedStyle(document.querySelector('.session-notice-title'), '::before').content;
`;

for (const theme of ["dark", "paper"]) for (const width of [384, 1500]) {
  test(`${theme} at ${width}px: the Mailbox row marker points right collapsed and down expanded`, { skip: !hasHeadlessChrome() }, () => {
    const m = measureUiMarkup<Measurement>(markup, width, `document.documentElement.dataset.theme='${theme}';${script}`);
    assert.deepEqual(m.collapsed, { right: true, down: false, open: false });
    assert.deepEqual(m.expanded, { right: false, down: true, open: true }, "a row that starts expanded shows the down marker");
    assert.deepEqual(m.toggled, { right: false, down: true, open: true }, "the marker follows activation");
    assert.deepEqual(m.keyboard, { right: true, down: false, open: false });
    assert.match(m.otherNotice, /^(none|normal)$/, "other system rows gain no marker");
  });
}
