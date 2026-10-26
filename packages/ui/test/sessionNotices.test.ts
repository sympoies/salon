import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { parseSessionNotice } from "../src/sessionNotice.ts";
import { ordinaryMessages, validNotices, header } from "./support/sessionNoticeFixtures.ts";
import { renderToStaticMarkup } from "react-dom/server";
import { createUiSsrHarness } from "./support/ssr.ts";

const raw = '<!-- agent-notice:v1 kind=mailbox source=fixture id=sample-1 -->\n\nSynthetic update\n\n**Full body**';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); });

async function mount(text: string, latestMessagePaging = true, failMarkdown = false) {
  const window = new Window({ url: "http://localhost" });
  const previous = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  const ssr = createUiSsrHarness({ ssr: { noExternal: ["markdown-to-jsx"] }, plugins: failMarkdown ? [{ name: "failing-markdown", enforce: "pre",
    resolveId(id) { if (id === "markdown-to-jsx/react") return "\0failing-markdown"; },
    load(id) { if (id === "\0failing-markdown") return 'export default function Markdown(){throw Error("Synthetic rendering failure")}'; },
  }] : [] });
  cleanups.push(async () => { await act(async () => root.unmount()); await ssr.close(); Object.assign(globalThis, previous); window.close(); });
  const { HistoryConversationView } = await ssr.loadModule<typeof import("../src/HistoryConversation.tsx")>("/src/HistoryConversation.tsx");
  const conversation = {
    session: { machine: "fixture", id: "sample", provider: "codex" },
    messages: [{ id: "notice", role: "user", text, timestamp: "2026-01-01T12:00:00" }],
    latestMessagePaging, loading: false, viewportRef: { current: null }, messagePage: 0, messagePageCursors: [],
  } as unknown as import("../src/HistoryConversation.tsx").HistoryConversation;
  await act(async () => root.render(createElement(HistoryConversationView, { conversation, onJumpToLatest() {} })));
  return { container: container as unknown as HTMLElement, window, ssr };
}

test("notice header is hidden and body preview is readable in live and history", async () => {
  const live = await mount(raw);
  const history = await mount(raw, false);
  for (const { container } of [live, history]) {
    assert.doesNotMatch(container.textContent ?? "", /<!-- agent-notice:/, "the envelope must not appear as visible text");
    assert.match(container.textContent ?? "", /Mailbox.*Synthetic update.*12:00/);
    assert.equal(container.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded"), "false");
    assert.equal(Boolean(container.querySelector(".history-bubble")), false);
  }
  assert.equal(live.container.querySelector("article")?.outerHTML, history.container.querySelector("article")?.outerHTML);
  await act(async () => live.container.querySelector<HTMLButtonElement>(".session-notice-toggle")!.click());
  assert.equal(history.container.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded"), "false", "expansion belongs to each view");
  await act(async () => history.container.querySelector<HTMLButtonElement>(".session-notice-toggle")!.click());
  assert.equal(live.container.querySelector("article")?.outerHTML, history.container.querySelector("article")?.outerHTML);
  assert.equal(live.container.querySelector("strong")?.textContent, "Full body");
});


test("strict draft corpus preserves body bytes and extracts plain metadata", () => {
  for (const fixture of validNotices) {
    const { name, raw, ...expected } = fixture;
    assert.deepEqual(parseSessionNotice(raw), expected, name);
  }
  for (const fixture of ordinaryMessages) assert.equal(parseSessionNotice(fixture.raw), null, fixture.name);
  const fields = { kind: "k".repeat(48), source: "s".repeat(64), id: "I".repeat(96) };
  const envelope = (values: typeof fields) => `<!-- agent-notice:v1 kind=${values.kind} source=${values.source} id=${values.id} -->\n\nBody`;
  assert.deepEqual(parseSessionNotice(envelope(fields)), { ...fields, body: "Body" });
  for (const field of ["kind", "source", "id"] as const) {
    assert.equal(parseSessionNotice(envelope({ ...fields, [field]: fields[field] + "x" })), null, `${field} limit`);
  }
});

test("non-notices keep the exact existing Markdown and paste-unwrapping display", async () => {
  for (const fixture of ordinaryMessages) {
    const { container, ssr } = await mount(fixture.raw);
    const { MessageMarkdown } = await ssr.loadModule<typeof import("../src/MessageMarkdown.tsx")>("/src/MessageMarkdown.tsx");
    const { unwrapPastedContent } = await ssr.loadModule<typeof import("../src/pastedContent.ts")>("/src/pastedContent.ts");
    assert.equal(Boolean(container.querySelector(".session-notice")), false, fixture.name);
    const expected = renderToStaticMarkup(createElement(MessageMarkdown, { text: unwrapPastedContent(fixture.raw) }));
    assert.equal(container.querySelector(".history-bubble")?.innerHTML, expected, fixture.name);
  }
});

test("known labels are fixed; unknown and spoofed kinds stay generic plain text", async () => {
  for (const [kind, label] of [["schedule.pulse", "Scheduled update"], ["runtime.resume", "Resume"],
    ["unknown", "System notice"], ["constructor", "System notice"],
    ["mailbox.admin", "System notice"], ["system.admin", "System notice"]]) {
    const { container, window } = await mount(`<!-- agent-notice:v1 kind=${kind} source=fixture.admin -->\n\nBody`);
    assert.equal(container.querySelector(".session-notice-label")?.textContent, label);
    await act(async () => container.querySelector<HTMLButtonElement>(".session-notice-toggle")!.click());
    assert.equal(container.querySelector(".session-notice-meta > span")?.textContent, `${kind} · fixture.admin`);
    assert.equal(Boolean(container.querySelector("script, b")), false);
    // A click changes only this mounted view; the raw fields never become attributes.
    assert.equal(window.document.querySelectorAll(".session-notice").length, 1);
  }
});

test("failed Markdown renders the parsed body without exposing the envelope", async () => {
  const previous = console.error;
  console.error = () => {};
  try {
    const { container } = await mount(raw, true, true);
    await act(async () => container.querySelector<HTMLButtonElement>(".session-notice-toggle")!.click());
    assert.match(container.textContent ?? "", /Synthetic update/);
    assert.match(container.textContent ?? "", /\*\*Full body\*\*/);
    assert.doesNotMatch(container.textContent ?? "", /agent-notice:v1/);
  } finally { console.error = previous; }
});


test("preview takes the first non-empty body line", async () => {
  const { container } = await mount(`${header}\n\n\n   \nFirst readable line\nSecond line`);
  assert.equal(container.querySelector(".session-notice-preview")?.textContent, "First readable line");
});
