import { strict as assert } from "node:assert";
import { test } from "node:test";
import { terminalAppearanceFor, terminalThemeFor } from "../src/terminalTheme.ts";
import { THEME_META_COLORS } from "../src/theme.ts";

function luminance(hex: string): number {
  const [r, g, b] = hex.slice(1, 7).match(/../g)!.map(pair => parseInt(pair, 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return r! * 0.2126 + g! * 0.7152 + b! * 0.0722;
}
function ratio(a: string, b: string): number {
  const [low, high] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (high! + 0.05) / (low! + 0.05);
}
const ansi = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"] as const;

test("the dark terminal palette is the unchanged Night Owl theme", () => {
  assert.deepEqual(terminalThemeFor("dark"), {
    background: "#011627", foreground: "#d6deeb", cursor: "#bec5d4", cursorAccent: "#011627",
    selectionBackground: "#637777", selectionForeground: "#ffffff",
    black: "#011627", red: "#f78c6c", green: "#addb67", yellow: "#ffcb8b", blue: "#82aaff", magenta: "#c792ea", cyan: "#7fdbca",
    white: "#bec5d4", brightBlack: "#44596b", brightRed: "#ef5350", brightGreen: "#22da6e", brightYellow: "#ffeb95",
    brightBlue: "#5ca7e4", brightMagenta: "#7e57c2", brightCyan: "#21c7a8", brightWhite: "#ffffff",
  });
});

test("the terminal canvas matches the page canvas in both themes so the pane has no seam", () => {
  assert.equal(terminalThemeFor("dark").background, THEME_META_COLORS.dark);
  assert.equal(terminalThemeFor("paper").background, THEME_META_COLORS.paper);
});

test("the Paper terminal text, every ANSI colour and the cursor are readable on its canvas", () => {
  const theme = terminalThemeFor("paper");
  assert.ok(ratio(theme.foreground!, theme.background!) >= 7, "foreground");
  for (const name of ansi) {
    const measured = ratio(theme[name]!, theme.background!);
    assert.ok(measured >= 4.5, `${name} ${theme[name]}: ${measured.toFixed(2)}:1`);
  }
  assert.ok(ratio(theme.cursor!, theme.background!) >= 3, "cursor");
  assert.ok(ratio(theme.selectionForeground!, theme.selectionBackground!) >= 4.5, "selected text");
  assert.ok(ratio(theme.selectionBackground!, theme.background!) >= 1.3, "selection is distinguishable from the canvas");
});

test("only Paper adds a renderer contrast floor, so dark rendering stays as it was", () => {
  assert.deepEqual(terminalAppearanceFor("dark"), { theme: terminalThemeFor("dark"), minimumContrastRatio: 1 });
  assert.deepEqual(terminalAppearanceFor("paper"), { theme: terminalThemeFor("paper"), minimumContrastRatio: 4.5 });
});
