import { strict as assert } from "node:assert";
import { test } from "node:test";
import { hasHeadlessChrome, measureUiMarkup } from "./support/browserLayout.ts";
import { renderNoticeSurface } from "./support/noticeSurfaces.ts";

interface Box { readonly top: number; readonly bottom: number }
interface Measurement {
  readonly borderWidth: string; readonly borderColor: string; readonly background: string; readonly textColor: string;
  readonly shadow: string; readonly radius: string; readonly buttonRadius: string;
  readonly pill: Box & { readonly width: number }; readonly counts: Box | null;
}

/** Parse the computed colour forms Chrome reports: rgb()/rgba() and color(srgb r g b / a). */
function parseColor(value: string): { rgb: [number, number, number]; alpha: number } {
  const numbers = value.match(/-?\d*\.?\d+(?:e-?\d+)?/g)?.map(Number) ?? [];
  assert.ok(numbers.length >= 3, `unparsed colour ${value}`);
  const unit = value.startsWith("color(");
  const rgb = numbers.slice(0, 3).map(n => unit ? n * 255 : n) as [number, number, number];
  return { rgb, alpha: numbers[3] ?? 1 };
}
function luminance([r, g, b]: [number, number, number]): number {
  const [lr, lg, lb] = [r, g, b].map(channel => { const c = channel / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }) as [number, number, number];
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}
function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function measure(markup: string, width: number): Measurement {
  return measureUiMarkup<Measurement>(`<style>:root{--ac-safe-area-top:0px}</style>${markup}`, width, `
    const pill = document.querySelector('.connection-notice');
    const style = getComputedStyle(pill);
    const probe = document.createElement('button'); probe.className = 'btn'; document.body.append(probe);
    const box = el => { const r = el.getBoundingClientRect(); return {top:r.top, bottom:r.bottom, width:r.width}; };
    const counts = pill.closest('.slot-focus-strip')?.querySelector('.session-status-counts');
    const result = {
      borderWidth: style.borderTopWidth, borderColor: style.borderTopColor, background: style.backgroundColor,
      textColor: getComputedStyle(pill.querySelector('.connection-notice-message')).color,
      shadow: style.boxShadow, radius: style.borderTopLeftRadius, buttonRadius: getComputedStyle(probe).borderTopLeftRadius,
      pill: box(pill), counts: counts ? box(counts) : null,
    };
  `);
}

const TIERS = [360, 412, 600, 768, 1280];
for (const place of ["list header", "conversation page"] as const) {
  for (const restore of [false, true]) {
    for (const width of TIERS) {
      // A focused session at desktop width puts the notice in the desktop strip; the phone strip is the conversation page.
      if (place === "conversation page" && width > 760) continue;
      test(`${width}px ${place} ${restore ? "restored" : "warning"} notice is a tinted header control`, async (t) => {
        if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
        const markup = await renderNoticeSurface("dashboard", width, { restore, focused: place === "conversation page", phoneFocusCounts: true });
        const m = measure(markup, width);
        assert.ok(m.pill.width > 40, `notice is visible: ${JSON.stringify(m.pill)}`);
        assert.equal(m.borderWidth, "1px");
        assert.equal(m.shadow, "none", "inline notice has no floating elevation");
        assert.equal(m.radius, m.buttonRadius, "notice uses the header button radius");
        const border = parseColor(m.borderColor);
        assert.ok(border.alpha > 0.2 && border.alpha < 0.5, `border is a tinted state colour (alpha ${border.alpha})`);
        const background = parseColor(m.background);
        assert.equal(background.alpha, 1, "tinted background is opaque");
        const ratio = contrast(parseColor(m.textColor).rgb, background.rgb);
        assert.ok(ratio >= 4.5, `message contrast ${ratio.toFixed(2)} meets WCAG AA`);
        if (place === "conversation page") {
          assert.ok(m.counts, "conversation page has the status-count row");
          const centre = (box: Box) => (box.top + box.bottom) / 2;
          assert.ok(Math.abs(centre(m.pill) - centre(m.counts!)) <= 1, `notice centre ${centre(m.pill)} matches count row centre ${centre(m.counts!)}`);
          assert.ok(m.pill.top >= 3, `notice keeps clear of the top edge (${m.pill.top}px)`);
        }
      });
    }
  }
}
