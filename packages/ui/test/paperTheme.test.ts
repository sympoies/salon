import { strict as assert } from "node:assert";
import { test } from "node:test";
import { uiSource, uiStyles } from "./support/source.ts";

const css = uiStyles();

function declarations(block: string): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const match of block.matchAll(/(--[\w-]+):\s*([^;]+);/g)) tokens.set(match[1]!, match[2]!.trim());
  return tokens;
}
function blockOf(selector: string): Map<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing ${selector} block`);
  return declarations(match[1]!);
}
const dark = blockOf(":root");
const paper = blockOf(':root[data-theme="paper"]');

function channel(hex: string): number[] {
  return hex.slice(1).match(/../g)!.map(pair => parseInt(pair, 16));
}
function luminance(rgb: number[]): number {
  const [r, g, b] = rgb.map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return r! * 0.2126 + g! * 0.7152 + b! * 0.0722;
}
function ratio(a: number[], b: number[]): number {
  const [low, high] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (high! + 0.05) / (low! + 0.05);
}
/** Resolve a token to #rrggbb within the paper theme, following var() aliases to paper then dark. */
function paperColor(name: string): number[] {
  let value = paper.get(name) ?? dark.get(name);
  for (let hops = 0; value !== undefined && hops < 8; hops++) {
    const alias = value.match(/^var\((--[\w-]+)\)$/);
    if (!alias) break;
    value = paper.get(alias[1]!) ?? dark.get(alias[1]!);
  }
  assert.match(value ?? "", /^#[\da-f]{6}$/i, `${name} resolves to ${value}`);
  return channel(value!);
}
function blend(over: number[], alpha: number, under: number[]): number[] {
  return over.map((value, index) => Math.round(value * alpha + under[index]! * (1 - alpha)));
}

const hex = (rgb: number[]) => `#${rgb.map(value => value.toString(16).padStart(2, "0")).join("")}`;
test("the paper palette keeps the approved base colours", () => {
  const approved: Record<string, string> = {
    "--surface-canvas": "#f4f3ed", "--panel": "#ffffff", "--line": "#c7c9bf",
    "--fg": "#1f2520", "--muted": "#5d645c", "--accent": "#2457a7", "--ok": "#2d6c3f", "--warn": "#855b00", "--err": "#a43c2e",
  };
  for (const [name, value] of Object.entries(approved)) assert.equal(hex(paperColor(name)), value, name);
  assert.match(css, /:root\[data-theme="paper"\]\s*\{[^}]*color-scheme:\s*light/);
});

test("paper redefines every colour token the dark root defines", () => {
  const colourLiteral = /#[\da-f]{3,8}\b|rgba?\(\s*\d/i;
  const missing = [...dark].filter(([name, value]) => colourLiteral.test(value) && !paper.has(name)).map(([name]) => name);
  assert.deepEqual(missing, []);
});

const surfaces = ["--surface-canvas", "--surface-card", "--surface-toolbar", "--surface-floating", "--surface-inset", "--surface-overlay", "--surface-control"];
test("text on paper clears WCAG AA 4.5:1 on every surface", () => {
  for (const text of ["--fg", "--fg-2", "--muted"]) for (const surface of surfaces) {
    const measured = ratio(paperColor(text), paperColor(surface));
    assert.ok(measured >= 4.5, `${text} on ${surface}: ${measured.toFixed(2)}:1`);
  }
});

test("status colours and the accent on paper clear 4.5:1 as text on every surface", () => {
  for (const status of ["--ok", "--warn", "--err", "--accent", "--cyan", "--account"]) for (const surface of surfaces) {
    const measured = ratio(paperColor(status), paperColor(surface));
    assert.ok(measured >= 4.5, `${status} on ${surface}: ${measured.toFixed(2)}:1`);
  }
  assert.ok(ratio(paperColor("--accent-fg"), paperColor("--accent")) >= 4.5, "text on an accent fill");
});

test("role markers (agent badges) on paper clear 4.5:1 over their tinted fills", () => {
  const tints: Record<string, number[]> = { codex: [36, 87, 167], claude: [217, 119, 87], dsh: [107, 118, 255] };
  for (const [role, tint] of Object.entries(tints)) for (const surface of ["--surface-card", "--surface-canvas"]) {
    const under = paperColor(surface);
    const measured = ratio(paperColor(`--badge-${role}-fg`), blend(tint, 0.14, under));
    assert.ok(measured >= 4.5, `${role} marker on ${surface}: ${measured.toFixed(2)}:1`);
  }
});

test("session state colours clear 4.5:1 as text and usage meters 3:1 as graphics on paper", () => {
  for (const name of [...paper.keys()].filter(key => /^--(status|meter)-/.test(key))) {
    const minimum = name.startsWith("--status-") ? 4.5 : 3;
    for (const surface of ["--surface-card", "--surface-canvas"]) {
      const measured = ratio(paperColor(name), paperColor(surface));
      assert.ok(measured >= minimum, `${name} on ${surface}: ${measured.toFixed(2)}:1`);
    }
  }
  assert.ok([...paper.keys()].some(key => key.startsWith("--status-working")), "session state tokens exist");
});

test("the solid Claude role marker in history keeps its glyph readable and stays visible against the conversation pane", () => {
  const marker = paperColor("--badge-claude-solid");
  assert.ok(ratio([255, 255, 255], marker) >= 4.5, "glyph on marker");
  assert.ok(ratio(marker, paperColor("--conversation-pane")) >= 3, "marker on pane");
});

test("popups, menus and viewers take their surfaces from tokens, not dark-only literals", () => {
  for (const file of ["terminalLinks.ts", "sessionCopyMenu.css", "ConversationImages.css"]) {
    const source = uiSource(file);
    assert.doesNotMatch(source.replace(/rgba\(0,\s*0,\s*0,\s*\.75\)/, ""), /#0008|rgba\(1, 22, 39|#d6deeb|rgba\(0,\s*0,\s*0,\s*\.94\)/, `${file} keeps a dark-only colour`);
  }
});
