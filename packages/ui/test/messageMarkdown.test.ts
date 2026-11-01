import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { assertNoElement } from "./support/domAssert.ts";
import { createUiSsrHarness } from "./support/ssr.ts";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function renderMarkdown(text: string, props: { readonly uploadSessionId?: string } = {}) {
  const window = new Window({ url: "http://localhost" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  const ssr = createUiSsrHarness();
  cleanups.push(async () => {
    await act(async () => root.unmount());
    await ssr.close();
    Object.assign(globalThis, previous);
    window.close();
  });
  const { MessageMarkdown } = await ssr.loadModule<typeof import("../src/MessageMarkdown.tsx")>("/src/MessageMarkdown.tsx");
  await act(async () => root.render(createElement(MessageMarkdown, { text, ...props })));
  return { window, container: container as unknown as HTMLElement };
}

test("message Markdown renders raw HTML as literal text instead of elements", async () => {
  const { container } = await renderMarkdown(
    'Before <script>alert(1)</script> <img src=x onerror="alert(2)"> <iframe src="https://evil.example"></iframe>\n\n'
      + '<div onclick="alert(3)">block html</div>\n\n<b>bold?</b>',
  );
  for (const selector of ["script", "img", "iframe", "div[onclick]", "b", "[onerror]"]) {
    assertNoElement(container, `.message-markdown ${selector}`);
  }
  const text = container.textContent ?? "";
  assert.match(text, /<script>alert\(1\)<\/script>/);
  assert.match(text, /<div onclick="alert\(3\)">block html<\/div>/);
});

test("message Markdown keeps only http(s) links and opens them outside the console", async () => {
  const { window, container } = await renderMarkdown(
    "[bad](javascript:alert(1)) [data](data:text/html,hi) [rel](src/app.ts) [ok](https://example.com/a) "
      + "![shot](https://example.com/shot.png)",
  );
  const anchors = [...container.querySelectorAll("a")];
  assert.deepEqual(anchors.map((anchor) => anchor.getAttribute("href")), ["https://example.com/a"]);
  for (const anchor of anchors) {
    assert.equal(anchor.getAttribute("target"), "_blank");
    assert.equal(anchor.getAttribute("rel"), "noopener noreferrer");
  }
  assertNoElement(container, "img", "unsupported sources never fetch an external image");
  assert.match(container.textContent ?? "", /bad data rel ok Image unavailable/);

  const opened: unknown[][] = [];
  Object.assign(window, { open: (...args: unknown[]) => { opened.push(args); return {}; } });
  const click = new window.MouseEvent("click", { bubbles: true, cancelable: true });
  anchors[0]?.dispatchEvent(click);
  assert.equal(click.defaultPrevented, true);
  assert.deepEqual(opened, [["https://example.com/a", "_blank", "noopener,noreferrer"]]);
});

test("message Markdown renders compact headings, tables, and soft line breaks", async () => {
  const { container } = await renderMarkdown(
    "# Conversation title\n\nline one\nline two\n\n| Check | State |\n| --- | --- |\n| CI | green |\n\n---\nnot frontmatter",
  );
  const heading = container.querySelector(".message-markdown h1");
  assert.equal(heading?.textContent, "Conversation title");
  assertNoElement(container, ".message-markdown [id]", "headings add no ids that could collide with the page");
  assert.deepEqual([...container.querySelectorAll("td")].map((cell) => cell.textContent), ["CI", "green"]);
  assert.match(container.textContent ?? "", /line one\nline two/);
  assert.match(container.textContent ?? "", /not frontmatter/);
});

test("message Markdown footnotes cannot place author-chosen ids on the page", async () => {
  const { container } = await renderMarkdown("See this[^conversation-composer].\n\n[^conversation-composer]: the note");
  assert.match(container.textContent ?? "", /the note/);
  assertNoElement(container, "[id]", "footnotes add no ids that could collide with the page");
});

test("message Markdown ignores attributes written into a code fence", async () => {
  const { container } = await renderMarkdown(
    '```js id="conversation-composer" style="color:red" autofocus="true" contenteditable="true" tabindex="0"\nconst x = 1;\n```\n\n'
      + '```js dangerouslySetInnerHTML="x"\nsecond\n```',
  );
  assert.deepEqual([...container.querySelectorAll("pre > code")].map((code) => code.textContent), ["const x = 1;", "second"]);
  for (const selector of ["[id]", "[style]", "[autofocus]", "[contenteditable]", "[tabindex]"]) {
    assertNoElement(container, selector, `a code fence cannot set ${selector}`);
  }
});

test("message Markdown keeps table alignment and task list checkboxes", async () => {
  const { container } = await renderMarkdown("| L | R |\n| :-- | --: |\n| a | b |\n\n- [x] done\n- [ ] todo");
  assert.equal(container.querySelector("td:last-child")?.getAttribute("style")?.replace(/\s/g, ""), "text-align:right;");
  assert.deepEqual([...container.querySelectorAll('input[type="checkbox"]')].map((box) => box.hasAttribute("checked")), [true, false]);
});

test("message Markdown renders a quoted voice transcript as one blockquote after typed text", async () => {
  const { container } = await renderMarkdown("typed text\n\n> [語音·Fast] line one\n> line two\n\n> [語音] second dictation");
  const quotes = [...container.querySelectorAll(".message-markdown blockquote")];
  assert.equal(quotes.length, 2);
  assert.match(quotes[0]?.textContent ?? "", /^\[語音·Fast\] line one\s*line two$/);
  assert.doesNotMatch(container.textContent ?? "", /^>|\n>/);
});

const OWN_DIR = "/state/sessions/s-1/attachments";

test("an owned quoted upload path renders as a short chip and hides the full path", async () => {
  const { container } = await renderMarkdown(`look at\n'${OWN_DIR}/shot.png'\n'${OWN_DIR}/notes.txt'`, { uploadSessionId: "s-1" });
  const chips = [...container.querySelectorAll<HTMLButtonElement>("button.attachment-chip")];
  assert.deepEqual(chips.map((chip) => chip.textContent), ["[圖片 shot.png]", "[檔案 notes.txt]"]);
  assert.doesNotMatch(container.textContent ?? "", /\/state\/sessions/);
});

test("selecting a chip copies the exact full path and shows feedback", async () => {
  const copied: string[] = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async (value: string) => { copied.push(value); } } } });
  cleanups.push(() => { if (previous) Object.defineProperty(globalThis, "navigator", previous); else Reflect.deleteProperty(globalThis, "navigator"); });
  const { window, container } = await renderMarkdown(`'${OWN_DIR}/my shot it'\\''s.png'`, { uploadSessionId: "s-1" });
  const chip = container.querySelector<HTMLButtonElement>("button.attachment-chip");
  assert.equal(chip?.textContent, "[圖片 my shot it's.png]");
  await act(async () => { chip?.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
  assert.deepEqual(copied, [`${OWN_DIR}/my shot it's.png`]);
  assert.match(container.querySelector("button.attachment-chip")?.textContent ?? "", /Copied/);
});

test("paths outside the session upload directory, code and unowned messages stay plain text", async () => {
  const other = "'/state/sessions/s-2/attachments/a.png'";
  const elsewhere = "'/data/file.txt'";
  const text = `${other} ${elsewhere}\n\n\`'${OWN_DIR}/c.png'\`\n\n\`\`\`\n'${OWN_DIR}/d.png'\n\`\`\``;
  const owned = await renderMarkdown(text, { uploadSessionId: "s-1" });
  assertNoElement(owned.container, "button.attachment-chip");
  assert.match(owned.container.textContent ?? "", /s-2\/attachments\/a\.png/);
  assert.match(owned.container.textContent ?? "", /\/data\/file\.txt/);
  assert.match(owned.container.textContent ?? "", /c\.png/);
  assert.match(owned.container.textContent ?? "", /d\.png/);
  const unowned = await renderMarkdown(`'${OWN_DIR}/shot.png'`);
  assertNoElement(unowned.container, "button.attachment-chip");
});

test("a chip sits inside a mixed message with a quoted voice transcript", async () => {
  const { container } = await renderMarkdown(`'${OWN_DIR}/shot.png'\n\n> [語音·Fast] line one\n> line two`, { uploadSessionId: "s-1" });
  assert.equal(container.querySelectorAll("button.attachment-chip").length, 1);
  assert.match(container.querySelector("blockquote")?.textContent ?? "", /^\[語音·Fast\] line one\s*line two$/);
});

test("quoted upload paths inside tilde-fenced and indented code stay literal code", async () => {
  const path = `'${OWN_DIR}/c.png'`;
  const text = `~~~sh\ncat ${path}\n~~~\n\n    run ${path}\n\n\`\`\`\`\n\`\`\`\n${path}\n\`\`\`\n\`\`\`\`\n\nafter ${path}`;
  const { container } = await renderMarkdown(text, { uploadSessionId: "s-1" });
  const chips = [...container.querySelectorAll("button.attachment-chip")];
  assert.deepEqual(chips.map((chip) => chip.textContent), ["[圖片 c.png]"], "only the paragraph after the code becomes a chip");
  const code = [...container.querySelectorAll("pre")].map((pre) => pre.textContent ?? "");
  assert.equal(code.length, 3);
  for (const block of code) assert.ok(block.includes(path), `code keeps the original quoted path: ${block}`);
  assert.doesNotMatch(container.textContent ?? "", /salon-attachment|\[file\]/);
});
