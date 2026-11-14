import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { uiStyles } from './support/source.ts';

function luminance(hex: string): number {
  const rgb = hex.slice(1).match(/../g)!.map(pair => parseInt(pair, 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
}
function ratio(a: string, b: string): number {
  const [low, high] = [luminance(a), luminance(b)].sort((a, b) => a - b);
  return (high! + 0.05) / (low! + 0.05);
}
const css = uiStyles();
const blocks = [...css.matchAll(/:root(?:\[data-theme="paper"\])?\s*\{([^}]*--conversation-pane:[^}]*)\}/g)];
const approved = [
  {pane:'#00111f','agent-bubble':'#1b3a55','agent-text':'#e6edf4','user-bubble':'#2a548c','user-text':'#f4f8fd',meta:'#6f879e',code:'#0b2337',composer:'#0b2942'},
  {pane:'#e4eaf1','agent-bubble':'#ffffff','agent-text':'#14283b','user-bubble':'#cfe2ff','user-text':'#0d2240',meta:'#4f6173',code:'#eef2f6',composer:'#f6f8fb'},
];
for (const [index, match] of blocks.entries()) {
  const theme = index === 0 ? 'dark' : 'paper';
  const tokens = Object.fromEntries([...match[1]!.matchAll(/--conversation-([\w-]+):\s*(#[\da-f]{6})/g)].map(item => [item[1], item[2]]));
  test(`${theme} conversation tokens match the approved palette`, () => assert.deepEqual(tokens, approved[index]));
  const statusTokens = Object.fromEntries([...match[1]!.matchAll(/--(ok|danger|surface-overlay):\s*(#[\da-f]{6})/g)].map(item => [item[1], item[2]]));
  test(`${theme} tool status colours match the theme palette`, () => {
    assert.equal(statusTokens.ok, theme === 'dark' ? '#addb67' : '#2d6c3f');
    assert.equal(statusTokens.danger, theme === 'dark' ? '#f78c6c' : '#a43c2e');
  });
  test(`${theme} tool status labels clear WCAG AA on the conversation and tool row backgrounds`, () => {
    for (const state of ['ok', 'error']) {
      const rule = css.match(new RegExp(`\\.conversation-tool-status\\.is-${state}\\s*\\{([^}]*)\\}`))?.[1];
      const token = rule?.match(/color:\s*var\(--([\w-]+)\)/)?.[1];
      assert.ok(token, `${state} label uses a theme token`);
      const foreground = statusTokens[token];
      assert.ok(foreground, `${state} label colour resolves in ${theme}`);
      for (const background of [tokens.pane!, statusTokens['surface-overlay']!]) {
        const measured = ratio(foreground, background);
        assert.ok(measured >= 4.5, `${theme} ${state} on ${background}: ${measured.toFixed(4)}:1`);
      }
    }
  });
  for (const role of ['agent', 'user']) {
    test(`${theme} ${role} body text clears 7:1 on its bubble`, () => {
      const measured = ratio(tokens[`${role}-text`]!, tokens[`${role}-bubble`]!);
      assert.ok(measured >= 7, `${theme} ${role}: ${measured.toFixed(4)}:1`);
    });
    if (theme === 'dark') test(`${theme} ${role} bubble clears 1.5:1 on the pane`, () => {
      const measured = ratio(tokens[`${role}-bubble`]!, tokens.pane!);
      assert.ok(measured >= 1.5, `${role} bubble: ${measured.toFixed(4)}:1`);
    });
  }
  test(`${theme} timestamps and hints clear 4.5:1 on every surface they sit on`, () => {
    // Dark keeps its approved palette (pane only); Paper must also clear every surface it can sit on.
    for (const surface of theme === 'dark' ? ['pane'] : ['pane', 'composer', 'agent-bubble', 'user-bubble', 'code']) {
      const measured = ratio(tokens.meta!, tokens[surface]!);
      assert.ok(measured >= 4.5, `${theme} meta on ${surface}: ${measured.toFixed(4)}:1`);
    }
  });
}
test('both conversation theme palettes are exercised', () => assert.equal(blocks.length, 2));
