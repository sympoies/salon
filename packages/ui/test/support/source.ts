import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

export function uiSource(path: string): string {
  return readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8");
}

export function uiStyles(): string {
  return uiSource("styles.css");
}

export function xtermSource(path: string): string {
  return readFileSync(new URL(`../../node_modules/@xterm/xterm/${path}`, import.meta.url), "utf8");
}

export function makeCssRuleLookup(css: string): (selector: string) => string {
  return (selector: string) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = css.match(new RegExp(`${escaped} \\{([\\s\\S]*?)\\}`));
    assert.ok(match, `missing CSS rule for ${selector}`);
    return match[1];
  };
}

export function sourceBlock(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  const endIndex = source.indexOf(end, startIndex);
  assert.notEqual(endIndex, -1, `missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}
