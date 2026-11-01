import { strict as assert } from "node:assert";
import { test } from "node:test";
import { hasHeadlessChrome, measureUiMarkup } from "./support/browserLayout.ts";
import { headerFixture } from "./support/headerFixture.ts";
import { uiSource, uiStyles } from "./support/source.ts";

// #968: the header follows the phone layout tier that Dashboard uses (width up
// to 760px, or a touch pointer up to 1024px). The layout button is hidden
// exactly when the phone layout is active, and phone count labels take the
// longest form that fits: full, then short, then the dot and number only.
type LabelMode = "full" | "short" | "none";
interface TierMeasure {
  readonly coarse: boolean;
  readonly stage: string | null;
  readonly picker: boolean;
  readonly mode: LabelMode;
  readonly fits: Record<LabelMode, boolean>;
  readonly labels: string[];
  readonly overlap: boolean;
  readonly overflow: number;
}

const COARSE = ["--blink-settings=primaryPointerType=2,availablePointerTypes=2"];
const OWNER_COUNTS = { working: 3, waiting: 11, attention: 0, unknown: 0, stopped: 0 };
const BUSY_COUNTS = { working: 40, waiting: 50, attention: 10, unknown: 0, stopped: 20 };

// The fit of each label form is forced with inline styles, independent of how
// production picks one, then cleared before the chosen form is read.
const measure = `
  const header=document.querySelector('.workspace-head');
  const visible=e=>!!e&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;
  // The counts container stretches to its grid cell; the buttons are what must
  // fit, neither clipped (they shrink before they overlap) nor overlapping.
  const row=[...header.querySelectorAll('.brand-title-mark,.layout-picker,.header-menu-trigger,.dashboard-new-session')];
  const separate=()=>{const buttons=[...header.querySelectorAll('.session-status-count')].map(e=>e.getBoundingClientRect());
    const c={left:Math.min(...buttons.map(r=>r.left)),right:Math.max(...buttons.map(r=>r.right)),top:Math.min(...buttons.map(r=>r.top)),bottom:Math.max(...buttons.map(r=>r.bottom))};
    const h=header.getBoundingClientRect();
    return row.filter(visible).every(e=>{const r=e.getBoundingClientRect();
      return r.bottom<=c.top||r.top>=c.bottom||r.right<=c.left+1||r.left>=c.right-1;})&&c.left>=h.left-1&&c.right<=h.right+1
      &&[...header.querySelectorAll('.session-status-count')].every(e=>e.scrollWidth<=e.clientWidth+1);};
  const force=mode=>{for(const e of header.querySelectorAll('.session-status-count-label'))e.style.display=mode==='full'?'inline':'none';
    for(const e of header.querySelectorAll('.session-status-count-short-label'))e.style.display=mode==='short'?'inline':'none';};
  const fits={};
  for(const mode of ['full','short','none']){force(mode);fits[mode]=separate();}
  for(const e of header.querySelectorAll('.session-status-count-label,.session-status-count-short-label'))e.style.removeProperty('display');
  const shown=s=>[...header.querySelectorAll(s)].filter(visible);
  const full=shown('.session-status-count-label'),short=shown('.session-status-count-short-label');
  const result={coarse:matchMedia('(pointer: coarse)').matches,stage:header.getAttribute('data-header-compact'),
    picker:[...header.querySelectorAll('.layout-picker,.layout-picker *')].some(visible),
    mode:full.length?'full':short.length?'short':'none',fits,labels:[...full,...short].map(e=>e.textContent),
    overlap:!separate(),overflow:document.documentElement.scrollWidth-innerWidth};
`;

async function measureTier(width: number, coarse: boolean, statusCounts = BUSY_COUNTS): Promise<TierMeasure> {
  const fixture = await headerFixture();
  try {
    return measureUiMarkup<TierMeasure>(fixture.markup(width, coarse, false, false, statusCounts), width,
      fixture.compact + measure, false, 800, coarse ? COARSE : []);
  } finally { await fixture.close(); }
}

const phoneCases = [
  { name: "phone portrait", width: 384, coarse: true, counts: OWNER_COUNTS },
  { name: "phone portrait with busy counts", width: 360, coarse: true, counts: BUSY_COUNTS },
  { name: "narrow web window", width: 760, coarse: false, counts: BUSY_COUNTS },
  { name: "phone landscape", width: 780, coarse: true, counts: OWNER_COUNTS },
  { name: "touch tablet", width: 1024, coarse: true, counts: BUSY_COUNTS },
] as const;

for (const { name, width, coarse, counts } of phoneCases) test(`${name} (${width}px${coarse ? " touch" : ""}) uses the phone header`, async t => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const m = await measureTier(width, coarse, counts);
  const detail = JSON.stringify(m);
  assert.equal(m.coarse, coarse, `the pointer type is emulated: ${detail}`);
  assert.equal(m.picker, false, `no layout button in the phone layout: ${detail}`);
  assert.equal(m.stage, null, `the phone header is not the desktop row: ${detail}`);
  const longest = (["full", "short", "none"] as const).find(mode => m.fits[mode]) ?? "none";
  assert.equal(m.mode, longest, `count labels take the longest form that fits: ${detail}`);
  assert.equal(m.overlap, false, `counts clear the brand and actions: ${detail}`);
  assert.ok(m.overflow <= 1, `no horizontal overflow: ${detail}`);
});

test("phone landscape shows the full count labels the owner expects", async t => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const m = await measureTier(780, true, OWNER_COUNTS);
  assert.deepEqual(m.labels, ["Working", "Waiting", "Attention", "Stop"], JSON.stringify(m));
});

for (const [width, coarse] of [[761, false], [1024, false], [1025, true], [1500, false]] as const) {
  test(`desktop (${width}px${coarse ? " touch" : ""}) keeps the measured row with the layout button`, async t => {
    if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
    const m = await measureTier(width, coarse);
    const detail = JSON.stringify(m);
    assert.equal(m.picker, true, `the layout button stays: ${detail}`);
    assert.notEqual(m.stage, null, `the desktop row is measured: ${detail}`);
    assert.equal(m.mode, "none", `the desktop row keeps dot and number counts: ${detail}`);
    assert.ok(m.overflow <= 1, `no horizontal overflow: ${detail}`);
  });
}

// One rule (#968): the header's media queries and its measurement use the same
// phone tier as Dashboard's single-column layout.
test("the header CSS and measurement share Dashboard's phone tier", () => {
  const phone = "(max-width: 760px), (pointer: coarse) and (max-width: 1024px)";
  const desktop = "(min-width: 1025px), (min-width: 761px) and (not (pointer: coarse))";
  assert.match(uiSource("Dashboard.tsx"), /mobile: width <= 760 \|\| \(\(coarse \|\| isAndroidTauri\(\)\) && width <= 1024\)/);
  assert.ok(uiSource("headerResponsive.ts").includes(`matchMedia("${phone}")`), "the measurement uses the phone tier");
  const css = uiStyles();
  const queryOf = (rule: string) => {
    const at = css.indexOf(rule);
    assert.ok(at >= 0, `missing rule: ${rule}`);
    return css.slice(css.lastIndexOf("@media", at), at).match(/^@media ([^{]+?) \{/)?.[1];
  };
  assert.equal(queryOf('grid-template-areas: "brand status actions" "pages pages pages" "filters filters filters";'), phone, "the two-row phone header");
  assert.equal(queryOf(".workspace-head .layout-picker { display: none; }"), phone, "no layout button in the phone layout");
  assert.equal(queryOf(".workspace-head .session-status-count-label,.workspace-head .session-status-count-short-label { display:none; }"), desktop,
    "the measured desktop row");
});
