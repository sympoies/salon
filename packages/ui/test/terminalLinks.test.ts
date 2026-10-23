import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Window } from "happy-dom";
import {
  DEFAULT_MAX_LINK_SCAN_CODE_UNITS,
  createOsc8LinkHandler,
  createTerminalLinkActivationGuard,
  createTerminalLinkHoverTarget,
  createTerminalLinkProvider,
  openExternalTerminalUrl,
  resolveTerminalUrlAtBufferCell,
  resolveTerminalUrlAtCell,
} from "../src/terminalLinks.ts";
import { assertNoElement } from "./support/domAssert.ts";

type FakeCell = { readonly chars: string; readonly width: number };

function fakeBufferLine(text: string, isWrapped: boolean) {
  const cells: FakeCell[] = [];
  for (const character of text) {
    const width = /[^\u0000-\u00ff]/u.test(character) ? 2 : 1;
    cells.push({ chars: character, width });
    if (width === 2) {
      cells.push({ chars: "", width: 0 });
    }
  }
  return {
    isWrapped,
    length: cells.length,
    translateToString(trimRight = false, startColumn = 0, endColumn = cells.length) {
      const value = cells
        .slice(startColumn, endColumn)
        .filter((cell) => cell.width !== 0)
        .map((cell) => cell.chars)
        .join("");
      return trimRight ? value.trimEnd() : value;
    },
    getCell(column: number) {
      const cell = cells[column];
      return cell
        ? {
            getChars: () => cell.chars,
            getWidth: () => cell.width,
          }
        : undefined;
    },
  };
}

test("resolveTerminalUrlAtCell opens http/https URLs only when the clicked cell is inside the URL", () => {
  const line = "open https://example.test/docs?q=1.";
  assert.equal(resolveTerminalUrlAtCell(line, line.indexOf("https")), "https://example.test/docs?q=1");
  assert.equal(resolveTerminalUrlAtCell(line, line.indexOf("docs")), "https://example.test/docs?q=1");
  assert.equal(resolveTerminalUrlAtCell(line, line.length - 1), null);
});

test("resolveTerminalUrlAtCell normalizes www links and rejects unsafe schemes", () => {
  assert.equal(resolveTerminalUrlAtCell("see www.example.test/path)", 6), "https://www.example.test/path");
  assert.equal(resolveTerminalUrlAtCell("bad javascript:alert(1)", 6), null);
  assert.equal(resolveTerminalUrlAtCell("file:///etc/passwd", 2), null);
});

test("resolveTerminalUrlAtCell stops before prose separated by CJK punctuation", () => {
  const url = "https://github.com/sampleRepo/agent-runtime-kit/pull/576";
  const line = `I merged heuristic PR #576 (${url})，留下後續追蹤紀錄。[F3]`;

  assert.equal(resolveTerminalUrlAtCell(line, line.indexOf("https")), url);
  assert.equal(resolveTerminalUrlAtCell(line, line.indexOf("576", line.indexOf("https"))), url);
  assert.equal(resolveTerminalUrlAtCell(line, line.indexOf("留下")), null);
  assert.equal(resolveTerminalUrlAtCell(line, line.indexOf("F3")), null);
});

test("resolveTerminalUrlAtCell keeps balanced URL delimiters and excludes Markdown closers", () => {
  const url = "https://example.test/function_(name)?items=a,b";
  const line = `[reference](${url})，next`;

  assert.equal(resolveTerminalUrlAtCell(line, line.indexOf("function")), url);
  assert.equal(resolveTerminalUrlAtCell(line, line.indexOf("next")), null);
});

test("resolveTerminalUrlAtCell preserves a balanced closing delimiter at the end of a URL", () => {
  const url = "https://en.wikipedia.org/wiki/Function_(mathematics)";
  const line = `read ${url} next`;

  assert.equal(resolveTerminalUrlAtCell(line, line.indexOf("mathematics")), url);
  assert.equal(resolveTerminalUrlAtCell(line, line.indexOf(")")), url);
});

test("resolveTerminalUrlAtCell supports Unicode URL paths up to a CJK sentence boundary", () => {
  const url = "https://example.test/文件/路徑";
  const line = `詳情：${url}。下一句`;

  assert.equal(resolveTerminalUrlAtCell(line, line.indexOf("文件")), url);
  assert.equal(resolveTerminalUrlAtCell(line, line.indexOf("下一句")), null);
});

test("resolveTerminalUrlAtCell keeps cell ranges isolated across multiple URLs", () => {
  const first = "https://first.example/a";
  const second = "www.second.example/b";
  const line = `${first}，然後 ${second}。`;

  assert.equal(resolveTerminalUrlAtCell(line, line.indexOf("first")), first);
  assert.equal(resolveTerminalUrlAtCell(line, line.indexOf("然後")), null);
  assert.equal(resolveTerminalUrlAtCell(line, line.indexOf("second")), `https://${second}`);
  assert.equal(resolveTerminalUrlAtCell(line, line.length - 1), null);
});

test("resolveTerminalUrlAtBufferCell restores a URL split across wrapped terminal rows", () => {
  const url = "https://github.com/exampleOrg/agent-console/pull/263";
  const splitAt = url.indexOf("agent-console");
  const lines = [
    { isWrapped: false, text: `PR (${url.slice(0, splitAt)}` },
    { isWrapped: true, text: `${url.slice(splitAt)}) done` },
  ];
  const buffer = {
    getLine(row: number) {
      const line = lines[row];
      return line
        ? {
            isWrapped: line.isWrapped,
            translateToString: (_trimRight?: boolean, startColumn = 0, endColumn = line.text.length) =>
              line.text.slice(startColumn, endColumn),
          }
        : undefined;
    },
  };

  assert.equal(resolveTerminalUrlAtBufferCell(buffer, 0, 8), url);
  assert.equal(resolveTerminalUrlAtBufferCell(buffer, 1, 4), url);
});

test("resolveTerminalUrlAtBufferCell joins full rows that arrive without wrap flags", () => {
  // tmux replays scrollback as hard rows and repaints via cursor addressing, so
  // xterm never marks these rows isWrapped even though they are one logical line.
  const cols = 30;
  const url = "https://example.test/download/very-long-path";
  const lines = [
    fakeBufferLine(url.slice(0, cols), false),
    fakeBufferLine(`${url.slice(cols)} done`, false),
  ];
  const buffer = { getLine: (row: number) => lines[row] };

  assert.equal(resolveTerminalUrlAtBufferCell(buffer, 0, 5), url);
  assert.equal(resolveTerminalUrlAtBufferCell(buffer, 1, 2), url);
});

test("a full word-character row above a row-start URL never suppresses that URL", () => {
  // `\b` cannot match at a joined `…ahttps://` junction, so URL starts must be
  // anchored at row junctions or joining would lose links per-row scanning found.
  const lines = [
    fakeBufferLine(`${"x".repeat(23)}a`, false),
    fakeBufferLine("https://example.test/ok see", false),
  ];
  const buffer = { getLine: (row: number) => lines[row] };

  assert.equal(resolveTerminalUrlAtBufferCell(buffer, 1, 2), "https://example.test/ok");
});

test("junction anchors never resurrect a URL fragment inside a genuine soft-wrapped word", () => {
  // isWrapped proves the two rows are one logical word, so a `https://` that
  // happens to start exactly at the wrap column must stay plain text, exactly
  // as it renders on an unwrapped terminal.
  const lines = [
    fakeBufferLine("A".repeat(24), false),
    fakeBufferLine("https://evil.test/x", true),
  ];
  const buffer = { getLine: (row: number) => lines[row] };

  for (let column = 0; column < 19; column += 1) {
    assert.equal(resolveTerminalUrlAtBufferCell(buffer, 1, column), null);
  }
});

test("a full row adjoining an overlong soft-wrap chain never suppresses the anchor URL", () => {
  // Heuristic joins that walk into a huge isWrapped chain must stop within
  // budget instead of tripping the maxRows fail-close for the anchor row.
  const chainHead = fakeBufferLine("w".repeat(80), false);
  const chainRow = fakeBufferLine("w".repeat(80), true);
  const anchor = fakeBufferLine("see https://anchor.test/ok here", false);
  const lines = Array.from({ length: 141 }, (_, row) => {
    if (row === 0) {
      return chainHead;
    }
    return row < 140 ? chainRow : anchor;
  });
  const buffer = { getLine: (row: number) => lines[row] };

  assert.equal(resolveTerminalUrlAtBufferCell(buffer, 140, 6), "https://anchor.test/ok");
});

test("a URL ending flush at the last column absorbs a URL-legal continuation", () => {
  // Accepted cost of the hard-wrap join: this shape is indistinguishable from a
  // genuinely wrapped URL, and the row-fullness signal is forgeable by adjacent
  // independent lines. The hover target and OSC 8 confirmation still disclose
  // the exact URL before it opens; see docs/terminal-internals.md.
  const lines = [
    fakeBufferLine("see https://good.example", false),
    fakeBufferLine(".evil.example/x done", false),
  ];
  const buffer = { getLine: (row: number) => lines[row] };

  assert.equal(resolveTerminalUrlAtBufferCell(buffer, 0, 6), "https://good.example.evil.example/x");
});

test("heuristic joins never push a soft-wrapped logical line into truncation", () => {
  // Anchor row heads a ~3600-unit genuinely soft-wrapped chain; full unflagged
  // rows sit above it. Heuristic up-joins must stop within the remaining
  // code-unit headroom instead of failing the whole anchor scan closed.
  const junkRow = fakeBufferLine("z".repeat(120), false);
  const headRow = fakeBufferLine(`https://example.test/ok ${"y ".repeat(48)}`, false);
  const wrappedRow = fakeBufferLine("y ".repeat(60), true);
  const lines = Array.from({ length: 47 }, (_, row) => {
    if (row < 17) {
      return junkRow;
    }
    return row === 17 ? headRow : wrappedRow;
  });
  const provider = createTerminalLinkProvider({
    buffer: { active: { getLine: (row: number) => lines[row] } },
  });

  let links: Parameters<Parameters<typeof provider.provideLinks>[1]>[0];
  provider.provideLinks(18, (provided) => {
    links = provided;
  });

  assert.equal(provider.stats().truncatedScans, 0);
  assert.equal(links?.[0]?.text, "https://example.test/ok");
});

test("resolveTerminalUrlAtBufferCell does not join rows that end short of the last column", () => {
  const lines = [
    fakeBufferLine("see https://first.test/a      ", false),
    fakeBufferLine("https://second.test/b", false),
  ];
  const buffer = { getLine: (row: number) => lines[row] };

  assert.equal(resolveTerminalUrlAtBufferCell(buffer, 0, 6), "https://first.test/a");
  assert.equal(resolveTerminalUrlAtBufferCell(buffer, 1, 2), "https://second.test/b");
});

test("openExternalTerminalUrl uses the native opener in Tauri and a new browser tab elsewhere", async () => {
  const opened: string[] = [];
  assert.equal(
    await openExternalTerminalUrl("https://example.test", {
      isTauri: () => true,
      openNativeUrl: async (url) => {
        opened.push(`native:${url}`);
      },
      openBrowserUrl: () => null,
    }),
    true,
  );
  assert.deepEqual(opened, ["native:https://example.test"]);

  assert.equal(
    await openExternalTerminalUrl("https://example.test", {
      isTauri: () => false,
      openNativeUrl: async () => {
        throw new Error("not expected");
      },
      openBrowserUrl: (url, target, features) => {
        opened.push(`browser:${url}:${target}:${features}`);
        return {} as Window;
      },
    }),
    true,
  );
  assert.equal(opened.at(-1), "browser:https://example.test:_blank:noopener,noreferrer");
});

test("custom link provider maps one implicit URL across wrapped xterm rows", () => {
  const lines = [
    fakeBufferLine("中 https://example.test/very", false),
    fakeBufferLine("long/path next", true),
  ];
  const opened: string[] = [];
  const provider = createTerminalLinkProvider(
    {
      buffer: {
        active: { getLine: (row: number) => lines[row] },
      },
    },
    {
      openUrl: (url) => {
        opened.push(url);
        return true;
      },
    },
  );

  let firstRowLinks: Parameters<Parameters<typeof provider.provideLinks>[1]>[0];
  let secondRowLinks: Parameters<Parameters<typeof provider.provideLinks>[1]>[0];
  provider.provideLinks(1, (links) => {
    firstRowLinks = links;
  });
  provider.provideLinks(2, (links) => {
    secondRowLinks = links;
  });

  assert.equal(firstRowLinks?.length, 1);
  assert.deepEqual(firstRowLinks?.[0]?.range, {
    start: { x: 4, y: 1 },
    end: { x: 9, y: 2 },
  });
  assert.deepEqual(secondRowLinks?.[0]?.range, firstRowLinks?.[0]?.range);
  assert.equal(firstRowLinks?.[0]?.text, "https://example.test/verylong/path");
  firstRowLinks?.[0]?.activate({ button: 0 } as MouseEvent, firstRowLinks[0].text);
  assert.deepEqual(opened, ["https://example.test/verylong/path"]);

  const stats = provider.stats();
  assert.equal(stats.providerCalls, 2);
  assert.equal(stats.logicalLineScans, 1);
  assert.equal(stats.cacheHits, 1);
  assert.equal(stats.maxScannedCodeUnits, "中 https://example.test/verylong/path next".length);
});

test("custom link provider rejects activation while the terminal owns mouse tracking", () => {
  // Index the fixture: a getLine that answers every row with the same filled
  // line chains the hard-wrap join until it trips the scan bound, and then no
  // link resolves at all, which would pass this assertion for the wrong reason.
  const lines = [fakeBufferLine("https://example.test", false)];
  let opens = 0;
  const provider = createTerminalLinkProvider(
    { buffer: { active: { getLine: (row: number) => lines[row] } } },
    {
      canActivate: () => false,
      openUrl: () => {
        opens += 1;
        return true;
      },
    },
  );
  let link: NonNullable<Parameters<Parameters<typeof provider.provideLinks>[1]>[0]>[number] | undefined;
  provider.provideLinks(1, (links) => {
    link = links?.[0];
  });
  link?.activate({ button: 0 } as MouseEvent, link.text);
  assert.equal(opens, 0);
});

test("custom link provider discloses a wrapped implicit target before opening it", () => {
  // The tapped row shows only the head of the URL; the rest lives on a
  // continuation row that can sit below the viewport. Disclose what will
  // actually open, not what the tapped row happens to show.
  const lines = [
    fakeBufferLine("https://example.test/very", false),
    fakeBufferLine("long/path next", true),
  ];
  const joined = "https://example.test/verylong/path";
  const activateWith = (accept: boolean) => {
    const opened: string[] = [];
    const disclosed: string[] = [];
    const provider = createTerminalLinkProvider(
      { buffer: { active: { getLine: (row: number) => lines[row] } } },
      {
        openUrl: (url) => {
          opened.push(url);
          return true;
        },
        requiresConfirmation: () => true,
        confirmUrl: (url) => {
          disclosed.push(url);
          return accept;
        },
      },
    );
    let link: NonNullable<Parameters<Parameters<typeof provider.provideLinks>[1]>[0]>[number] | undefined;
    provider.provideLinks(1, (links) => {
      link = links?.[0];
    });
    link?.activate({ button: 0 } as MouseEvent, link.text);
    return { opened, disclosed };
  };

  const declined = activateWith(false);
  assert.deepEqual(declined.disclosed, [joined]);
  assert.deepEqual(declined.opened, []);

  const accepted = activateWith(true);
  assert.deepEqual(accepted.disclosed, [joined]);
  assert.deepEqual(accepted.opened, [joined]);
});

test("custom link provider reports an implicit activation even when the target is declined", () => {
  // The touch caller uses this to decide the tap was consumed. Without it a
  // declined implicit link falls through to the untargeted text-scan fallback,
  // which would open the URL the user just refused.
  const lines = [fakeBufferLine("https://example.test/path", false)];
  const attempts: string[] = [];
  const opened: string[] = [];
  const provider = createTerminalLinkProvider(
    { buffer: { active: { getLine: (row: number) => lines[row] } } },
    {
      openUrl: (url) => {
        opened.push(url);
        return true;
      },
      onActivationAttempt: () => attempts.push("attempt"),
      requiresConfirmation: () => true,
      confirmUrl: () => false,
    },
  );
  let link: NonNullable<Parameters<Parameters<typeof provider.provideLinks>[1]>[0]>[number] | undefined;
  provider.provideLinks(1, (links) => {
    link = links?.[0];
  });
  link?.activate({ button: 0 } as MouseEvent, link.text);
  assert.deepEqual(attempts, ["attempt"]);
  assert.deepEqual(opened, []);

  // A rejected activation is not an attempt: the pane owns the mouse.
  const blocked = createTerminalLinkProvider(
    { buffer: { active: { getLine: (row: number) => lines[row] } } },
    { canActivate: () => false, onActivationAttempt: () => attempts.push("blocked") },
  );
  let blockedLink: NonNullable<Parameters<Parameters<typeof blocked.provideLinks>[1]>[0]>[number] | undefined;
  blocked.provideLinks(1, (links) => {
    blockedLink = links?.[0];
  });
  blockedLink?.activate({ button: 0 } as MouseEvent, blockedLink.text);
  assert.deepEqual(attempts, ["attempt"]);
});

test("custom link provider withholds an implicit target when confirmation is unavailable", () => {
  const lines = [fakeBufferLine("https://example.test/path", false)];
  const opened: string[] = [];
  const provider = createTerminalLinkProvider(
    { buffer: { active: { getLine: (row: number) => lines[row] } } },
    {
      openUrl: (url) => {
        opened.push(url);
        return true;
      },
      requiresConfirmation: () => true,
    },
  );
  let link: NonNullable<Parameters<Parameters<typeof provider.provideLinks>[1]>[0]>[number] | undefined;
  provider.provideLinks(1, (links) => {
    link = links?.[0];
  });
  link?.activate({ button: 0 } as MouseEvent, link.text);
  assert.deepEqual(opened, []);
});

test("custom link provider opens implicit links unprompted when no confirmation is required", () => {
  const lines = [fakeBufferLine("https://example.test/path", false)];
  const opened: string[] = [];
  let confirmCalls = 0;
  const provider = createTerminalLinkProvider(
    { buffer: { active: { getLine: (row: number) => lines[row] } } },
    {
      openUrl: (url) => {
        opened.push(url);
        return true;
      },
      confirmUrl: () => {
        confirmCalls += 1;
        return true;
      },
    },
  );
  let link: NonNullable<Parameters<Parameters<typeof provider.provideLinks>[1]>[0]>[number] | undefined;
  provider.provideLinks(1, (links) => {
    link = links?.[0];
  });
  link?.activate({ button: 0 } as MouseEvent, link.text);
  assert.equal(confirmCalls, 0);
  assert.deepEqual(opened, ["https://example.test/path"]);
});

test("custom link provider walks backward and forward across a three-row URL", () => {
  const lines = [
    fakeBufferLine("https://example.test/", false),
    fakeBufferLine("middle-", true),
    fakeBufferLine("tail done", true),
  ];
  const provider = createTerminalLinkProvider({
    buffer: { active: { getLine: (row: number) => lines[row] } },
  });
  let links: Parameters<Parameters<typeof provider.provideLinks>[1]>[0];
  provider.provideLinks(2, (provided) => {
    links = provided;
  });
  assert.equal(links?.[0]?.text, "https://example.test/middle-tail");
  assert.deepEqual(links?.[0]?.range, {
    start: { x: 1, y: 1 },
    end: { x: 4, y: 3 },
  });
});

test("custom link provider maps a hard-wrapped URL delivered without wrap flags", () => {
  const cols = 20;
  const url = "https://example.test/abcdefghijklm";
  const lines = [
    fakeBufferLine(url.slice(0, cols), false),
    fakeBufferLine(`${url.slice(cols)} x`, false),
  ];
  const provider = createTerminalLinkProvider({
    buffer: { active: { getLine: (row: number) => lines[row] } },
  });

  let headLinks: Parameters<Parameters<typeof provider.provideLinks>[1]>[0];
  let tailLinks: Parameters<Parameters<typeof provider.provideLinks>[1]>[0];
  provider.provideLinks(1, (links) => {
    headLinks = links;
  });
  provider.provideLinks(2, (links) => {
    tailLinks = links;
  });

  assert.equal(headLinks?.[0]?.text, url);
  assert.deepEqual(headLinks?.[0]?.range, {
    start: { x: 1, y: 1 },
    end: { x: 14, y: 2 },
  });
  assert.deepEqual(tailLinks?.[0]?.range, headLinks?.[0]?.range);
});

test("hard-wrap joining stays bounded and never trips the truncation fail-close", () => {
  // Endless identical full rows: joining must stop within the URL-length budget
  // instead of scanning forever or pushing the window into truncation.
  const fullRow = fakeBufferLine("x".repeat(64), false);
  const provider = createTerminalLinkProvider({ buffer: { active: { getLine: () => fullRow } } });
  let provided: unknown = "unset";
  provider.provideLinks(1, (links) => {
    provided = links;
  });
  assert.equal(provided, undefined);
  assert.equal(provider.stats().truncatedScans, 0);
  assert.ok(provider.stats().maxScannedCodeUnits <= DEFAULT_MAX_LINK_SCAN_CODE_UNITS);
});

test("custom link provider fails closed when a wrapped logical line exceeds the scan bound", () => {
  const line = fakeBufferLine(`${"x".repeat(DEFAULT_MAX_LINK_SCAN_CODE_UNITS)}https://example.test`, false);
  const provider = createTerminalLinkProvider({ buffer: { active: { getLine: () => line } } });
  let provided: unknown = "unset";
  provider.provideLinks(1, (links) => {
    provided = links;
  });
  assert.equal(provided, undefined);
  assert.equal(provider.stats().truncatedScans, 1);
  assert.ok(provider.stats().maxScannedCodeUnits <= DEFAULT_MAX_LINK_SCAN_CODE_UNITS);
});

test("custom link provider bounds overlapping URL prefixes and total links per line", () => {
  const nested = fakeBufferLine(`https://a.test/${"www.".repeat(1000)}tail`, false);
  const nestedProvider = createTerminalLinkProvider({ buffer: { active: { getLine: () => nested } } });
  let nestedLinks: Parameters<Parameters<typeof nestedProvider.provideLinks>[1]>[0];
  nestedProvider.provideLinks(1, (links) => {
    nestedLinks = links;
  });
  assert.ok((nestedLinks?.length ?? 0) <= 1, "nested prefixes never create overlapping links");

  const many = fakeBufferLine(Array.from({ length: 40 }, (_, index) => `https://e${index}.test`).join(" "), false);
  const cappedProvider = createTerminalLinkProvider(
    { buffer: { active: { getLine: () => many } } },
    { maxLinks: 8 },
  );
  let cappedLinks: Parameters<Parameters<typeof cappedProvider.provideLinks>[1]>[0];
  cappedProvider.provideLinks(1, (links) => {
    cappedLinks = links;
  });
  assert.equal(cappedLinks?.length, 8);
});

test("terminal link activation guard accepts only stationary primary-button gestures", () => {
  const guard = createTerminalLinkActivationGuard({ moveThresholdPx: 3 });
  const primaryDown = { button: 0, clientX: 10, clientY: 20 } as MouseEvent;
  const primaryUp = { button: 0, clientX: 11, clientY: 21 } as MouseEvent;
  guard.onMouseDown(primaryDown);
  guard.onMouseUp(primaryUp);
  assert.equal(guard.canActivate(primaryUp), true);

  const draggedUp = { button: 0, clientX: 30, clientY: 20 } as MouseEvent;
  guard.onMouseDown(primaryDown);
  guard.onMouseMove({ button: 0, clientX: 20, clientY: 20 } as MouseEvent);
  guard.onMouseUp(draggedUp);
  assert.equal(guard.canActivate(draggedUp), false);

  const rightDown = { button: 2, clientX: 10, clientY: 20 } as MouseEvent;
  const rightUp = { button: 2, clientX: 10, clientY: 20 } as MouseEvent;
  guard.onMouseDown(rightDown);
  guard.onMouseUp(rightUp);
  assert.equal(guard.canActivate(rightUp), false);
});

test("implicit and OSC 8 links share a safe opener and inspectable hover target", async () => {
  const window = new Window({ url: "http://localhost" });
  const host = window.document.createElement("div");
  window.document.body.appendChild(host);
  const hoverTarget = createTerminalLinkHoverTarget(host as unknown as HTMLElement);
  const opened: string[] = [];
  const confirmed: string[] = [];
  const handler = createOsc8LinkHandler({
    hoverTarget,
    openUrl: (url) => {
      opened.push(url);
      return true;
    },
    requiresConfirmation: () => true,
    confirmUrl: (url) => {
      confirmed.push(url);
      return confirmed.length > 1;
    },
  });
  const range = { start: { x: 1, y: 1 }, end: { x: 4, y: 1 } };
  const event = new window.MouseEvent("mouseover", { clientX: 12, clientY: 18 }) as unknown as MouseEvent;

  handler.hover?.(event, "https://example.test/target", range);
  const popup = host.querySelector("[data-terminal-link-hover]");
  assert.equal(popup?.textContent, "https://example.test/target");
  assert.equal(popup?.getAttribute("role"), "status");

  handler.activate(event, "https://example.test/target", range);
  assert.deepEqual(opened, [], "first coarse-pointer activation only discloses the target");
  handler.activate(event, "https://example.test/target", range);
  handler.activate(new window.MouseEvent("mouseup", { button: 2 }) as unknown as MouseEvent, "https://example.test/target", range);
  handler.activate(event, "javascript:alert(1)", range);
  const oversized = `https://example.test/${"x".repeat(DEFAULT_MAX_LINK_SCAN_CODE_UNITS)}`;
  handler.hover?.(event, oversized, range);
  handler.activate(event, oversized, range);
  await Promise.resolve();
  assert.deepEqual(opened, ["https://example.test/target"]);
  assert.deepEqual(confirmed, ["https://example.test/target", "https://example.test/target"]);
  assertNoElement(host, "[data-terminal-link-hover]");
  assert.equal(handler.allowNonHttpProtocols, false);

  handler.leave?.(event, "https://example.test/target", range);
  assertNoElement(host, "[data-terminal-link-hover]");
  hoverTarget.dispose();
  await window.happyDOM.close();
});

test("explicit OSC 8 targets open the exact advertised URI without prose trimming", async () => {
  const opened: string[] = [];
  const handler = createOsc8LinkHandler({
    openUrl: (url) => {
      opened.push(url);
      return true;
    },
  });
  const range = { start: { x: 1, y: 1 }, end: { x: 4, y: 1 } };
  const leftClick = { button: 0 } as MouseEvent;
  const explicitTargets = [
    "https://example.com/search?",
    "https://example.com/a)b",
    "https://example.com/x?y=1.",
    "https://example.com/path.",
  ];
  for (const target of explicitTargets) {
    handler.activate(leftClick, target, range);
  }
  await Promise.resolve();
  assert.deepEqual(
    opened,
    explicitTargets,
    "OSC 8 activation must open the terminal-advertised target verbatim",
  );
});

test("OSC 8 confirm dialog and open receive the identical untrimmed target", async () => {
  const opened: string[] = [];
  const confirmed: string[] = [];
  const handler = createOsc8LinkHandler({
    openUrl: (url) => {
      opened.push(url);
      return true;
    },
    requiresConfirmation: () => true,
    confirmUrl: (url) => {
      confirmed.push(url);
      return true;
    },
  });
  const range = { start: { x: 1, y: 1 }, end: { x: 4, y: 1 } };
  const target = "https://example.com/download?";
  handler.activate({ button: 0 } as MouseEvent, target, range);
  await Promise.resolve();
  assert.deepEqual(confirmed, [target], "confirm dialog must show the exact target");
  assert.deepEqual(opened, [target], "the opened URL must match the confirmed target");
});

test("OSC 8 hover discloses the exact advertised target", async () => {
  const window = new Window({ url: "http://localhost" });
  const host = window.document.createElement("div");
  window.document.body.appendChild(host);
  const hoverTarget = createTerminalLinkHoverTarget(host as unknown as HTMLElement);
  const handler = createOsc8LinkHandler({ hoverTarget });
  const range = { start: { x: 1, y: 1 }, end: { x: 4, y: 1 } };
  const event = new window.MouseEvent("mouseover", { clientX: 12, clientY: 18 }) as unknown as MouseEvent;
  handler.hover?.(event, "https://example.com/search?", range);
  const popup = host.querySelector("[data-terminal-link-hover]");
  assert.equal(popup?.textContent, "https://example.com/search?");
  hoverTarget.dispose();
  await window.happyDOM.close();
});

test("openExternalTerminalUrl opens explicit targets without prose trimming", async () => {
  const opened: string[] = [];
  await openExternalTerminalUrl("https://example.com/x?y=1.", {
    isTauri: () => false,
    openNativeUrl: async () => {
      throw new Error("native opener not expected");
    },
    openBrowserUrl: (url) => {
      opened.push(url);
      return {} as Window;
    },
  });
  assert.deepEqual(opened, ["https://example.com/x?y=1."]);
});

test("implicit auto-detected links still trim trailing prose punctuation", () => {
  assert.equal(
    resolveTerminalUrlAtCell("see https://example.com/path.", 6),
    "https://example.com/path",
  );
});
