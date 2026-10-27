import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { parseSessionNotice } from "@agent-console/shared";
import { ordinaryMessages, validNotices, header } from "./support/sessionNoticeFixtures.ts";
import { renderToStaticMarkup } from "react-dom/server";
import { createUiSsrHarness } from "./support/ssr.ts";

const raw = '<!-- agent-notice:v1 kind=mailbox source=fixture id=sample-1 -->\n\nSynthetic update\n\n**Full body**';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); });

async function mount(text: string, latestMessagePaging = true) {
  const window = new Window({ url: "http://localhost" });
  const previous = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  const ssr = createUiSsrHarness({ ssr: { noExternal: ["markdown-to-jsx"] } });
  cleanups.push(async () => { await act(async () => root.unmount()); await ssr.close(); Object.assign(globalThis, previous); window.close(); });
  const { HistoryConversationView } = await ssr.loadModule<typeof import("../src/HistoryConversation.tsx")>("/src/HistoryConversation.tsx");
  const conversation = {
    session: { machine: "fixture", id: "sample", provider: "codex" },
    messages: [{ id: "notice", role: "user", text, timestamp: "2026-01-01T12:00:00" }],
    latestMessagePaging, loading: false, viewportRef: { current: null }, messagePage: 0, messagePageCursors: [],
  } as unknown as import("../src/HistoryConversation.tsx").HistoryConversation;
  await act(async () => root.render(createElement(HistoryConversationView, { conversation, onJumpToLatest() {} })));
  return { container: container as unknown as HTMLElement, window, ssr, root };
}

test("notice header is hidden and full plain-text body is visible in live and history", async () => {
  const live = await mount(raw);
  const history = await mount(raw, false);
  for (const { container } of [live, history]) {
    assert.doesNotMatch(container.textContent ?? "", /<!-- agent-notice:/, "the envelope must not appear as visible text");
    assert.match(container.textContent ?? "", /Mailbox.*12:00.*Synthetic update/s);
    assert.equal(Boolean(container.querySelector("button[aria-expanded]")), false);
    assert.equal(container.querySelector(".session-notice-body")?.textContent, parseSessionNotice(raw)?.body);
    assert.equal(Boolean(container.querySelector(".history-bubble")), false);
  }
  assert.equal(live.container.querySelector("article")?.outerHTML, history.container.querySelector("article")?.outerHTML);
  assert.equal(Boolean(live.container.querySelector("strong")), false, "Markdown stays literal");
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
    assert.equal(container.querySelector(".session-notice-meta > span")?.textContent, `${kind} · fixture.admin`);
    assert.equal(Boolean(container.querySelector("script, b")), false);
    // The raw fields remain plain text in this mounted view.
    assert.equal(window.document.querySelectorAll(".session-notice").length, 1);
  }
});

test("failed notice child renders the parsed body without exposing the envelope", async () => {
  const previous = console.error;
  console.error = () => {};
  try {
    const { container, ssr, root } = await mount(raw);
    const { SessionNotice } = await ssr.loadModule<typeof import("../src/SessionNotice.tsx")>("/src/SessionNotice.tsx");
    function FailedAttachment(): never { throw Error("Synthetic rendering failure"); }
    await act(async () => root.render(createElement(SessionNotice, {
      notice: parseSessionNotice(raw)!, raw, time: "12:00", suppressImages: false,
      children: createElement(FailedAttachment),
    })));
    assert.match(container.textContent ?? "", /Synthetic update/);
    assert.match(container.textContent ?? "", /\*\*Full body\*\*/);
    assert.doesNotMatch(container.textContent ?? "", /agent-notice:v1/);
  } finally { console.error = previous; }
});


test("body preserves blank lines and whitespace", async () => {
  const { container } = await mount(`${header}\n\n\n   \nFirst readable line\nSecond line`);
  assert.equal(container.querySelector(".session-notice-body")?.textContent, "\n   \nFirst readable line\nSecond line");
});
