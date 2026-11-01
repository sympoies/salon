import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { assertNoElement } from "./support/domAssert.ts";
import { createUiSsrHarness } from "./support/ssr.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); });

const mailbox = (overrides: Record<string, unknown> = {}) => ({
  schema_version: "agent-session.mailbox-read-event.v1",
  message_id: "m-1",
  sender: { kind: "session", machine: "machine-a", session_id: "sender-1" },
  category: "handoff", state: "read", read_at: "2026-11-02T01:02:03.456Z", acknowledged_at: null, revision: 1,
  availability: "complete",
  body_prefix: "none",
  ...overrides,
});
const eventText = (body: string) => `<!-- agent-notice:v1 kind=mailbox.read source=agent-session id=m-1 -->\n\n${body}`;
const timeline = (event: Record<string, unknown>) => [
  { id: "u1", role: "user", text: "Please review", timestamp: "2026-11-02T01:00:00.000Z" },
  { id: "h-1-m-1-mailbox", role: "notice", timestamp: "2026-11-02T01:02:03.456Z", ...event },
  { id: "a1", role: "assistant", text: "Reviewing now", timestamp: "2026-11-02T01:03:00.000Z" },
];

async function mount(messages: unknown[], storage?: Record<string, string>) {
  const window = new Window({ url: "http://localhost" });
  const saved = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
  for (const [key, value] of Object.entries(storage ?? {})) window.localStorage.setItem(key, value);
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  const ssr = createUiSsrHarness({ ssr: { noExternal: ["markdown-to-jsx"] } });
  cleanups.push(async () => { await act(async () => root.unmount()); await ssr.close(); Object.assign(globalThis, saved); window.close(); });
  const { HistoryConversationView } = await ssr.loadModule<typeof import("../src/HistoryConversation.tsx")>("/src/HistoryConversation.tsx");
  const conversation = {
    session: { machine: "fixture", id: "sample", provider: "codex" }, messages,
    latestMessagePaging: true, loading: false, viewportRef: { current: null }, messagePage: 0, messagePageCursors: [],
  } as unknown as import("../src/HistoryConversation.tsx").HistoryConversation;
  await act(async () => root.render(createElement(HistoryConversationView, { conversation, onJumpToLatest() {} })));
  return { window, container: container as unknown as HTMLElement, ssr };
}

test("a mailbox read event is a boxless row at its timeline position with sender, category and time", async () => {
  const { container } = await mount(timeline({ text: eventText("**Review** the change"), mailbox: mailbox() }));
  const articles = [...container.querySelectorAll("article")];
  assert.equal(articles.length, 3);
  const row = articles[1]!;
  assert.ok(row.matches(".history-message.is-notice"), "the event sits between the two messages around it");
  assert.ok(row.querySelector(".session-notice.mailbox-event"), "same boxless style as session notices");
  assertNoElement(row, ".history-bubble");
  const summary = row.querySelector("summary")!;
  assert.match(summary.textContent ?? "", /sender-1/);
  assert.match(summary.textContent ?? "", /machine-a/);
  assert.match(summary.textContent ?? "", /handoff/);
  assert.ok(summary.querySelector("time"), "the event time is shown");
  assert.match(summary.textContent ?? "", /Read/);
});

test("the row starts collapsed and expands to the full body rendered as Markdown without raw HTML", async () => {
  const { container, window } = await mount(timeline({ text: eventText("**Review** the change\n\n<script>alert(1)</script>\n\n- item"), mailbox: mailbox() }));
  const details = container.querySelector<HTMLDetailsElement>("details.mailbox-event-disclosure")!;
  assert.equal(details.open, false, "collapsed by default");
  await act(async () => { details.querySelector("summary")!.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
  assert.equal(details.open, true);
  const body = details.querySelector(".mailbox-event-body")!;
  assert.equal(body.querySelector("strong")?.textContent, "Review");
  assert.equal(body.querySelectorAll("li").length, 1);
  assertNoElement(body, "script");
  assert.match(body.textContent ?? "", /<script>alert\(1\)<\/script>/);
});

test("a leading-marker body loses exactly one LF and shows as plain text, never as a nested notice", async () => {
  const nested = "<!-- agent-notice:v1 kind=mailbox source=peer -->\n\nnested **body**\n";
  const { container } = await mount(timeline({ text: eventText(`\n${nested}`), mailbox: mailbox({ body_prefix: "lf" }) }), { "ac.mailboxRowsExpanded": "1" });
  const body = container.querySelector(".mailbox-event-body")!;
  assert.equal(body.querySelector("pre")?.textContent, nested, "the stored body byte for byte");
  assert.equal(container.querySelectorAll(".session-notice").length, 1, "no nested notice");
  assertNoElement(body, "strong");
  const plain = await mount(timeline({ text: eventText("\nkept"), mailbox: mailbox() }), { "ac.mailboxRowsExpanded": "1" });
  assert.match(plain.container.querySelector(".mailbox-event-body")?.textContent ?? "", /kept/);
});

test("the per-device setting makes rows start expanded", async () => {
  const { container } = await mount(timeline({ text: eventText("Body"), mailbox: mailbox() }), { "ac.mailboxRowsExpanded": "1" });
  assert.equal(container.querySelector<HTMLDetailsElement>("details.mailbox-event-disclosure")!.open, true);
});

test("an acknowledged event shows its state, and an event without a body shows fixed text", async () => {
  const acked = await mount(timeline({ text: eventText("Body"), mailbox: mailbox({ state: "acknowledged", acknowledged_at: "2026-11-02T01:05:00.000Z", revision: 2 }) }));
  assert.match(acked.container.querySelector("summary")?.textContent ?? "", /Acknowledged/);
  const empty = await mount(timeline({ text: eventText(""), mailbox: mailbox() }), { "ac.mailboxRowsExpanded": "1" });
  assert.match(empty.container.querySelector(".mailbox-event-body")?.textContent ?? "", /Message body unavailable/);
});

test("an older server or an event without valid mailbox fields renders as a plain notice, as before", async () => {
  const { container } = await mount(timeline({ text: eventText("Plain **notice**") }));
  assertNoElement(container, ".mailbox-event");
  assert.ok(container.querySelector(".session-notice"), "the existing notice rendering");
  assert.match(container.textContent ?? "", /Plain notice/);
});

test("the mailbox row setting persists on the device and defaults to collapsed", async () => {
  const window = new Window({ url: "http://localhost" });
  const saved = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const ssr = createUiSsrHarness();
  cleanups.push(async () => { await ssr.close(); Object.assign(globalThis, saved); window.close(); });
  const { MailboxRowSettings } = await ssr.loadModule<typeof import("../src/MailboxRowSettings.tsx")>("/src/MailboxRowSettings.tsx");
  const mountSettings = async () => {
    const container = window.document.createElement("div");
    window.document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(createElement(MailboxRowSettings)));
    return { container: container as unknown as HTMLElement, unmount: () => act(async () => root.unmount()) };
  };
  const first = await mountSettings();
  const toggle = () => first.container.querySelector<HTMLButtonElement>('[role="switch"]')!;
  assert.equal(toggle().getAttribute("aria-checked"), "false");
  await act(async () => { toggle().click(); });
  assert.equal(toggle().getAttribute("aria-checked"), "true");
  assert.equal(window.localStorage.getItem("ac.mailboxRowsExpanded"), "1");
  await first.unmount();
  const second = await mountSettings();
  assert.equal(second.container.querySelector('[role="switch"]')!.getAttribute("aria-checked"), "true");
  await act(async () => { second.container.querySelector<HTMLButtonElement>('[role="switch"]')!.click(); });
  assert.equal(window.localStorage.getItem("ac.mailboxRowsExpanded"), null);
});
