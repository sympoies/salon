import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement, useState, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import type { Plugin } from "vite";
import type { SessionSlotProps } from "../src/SessionSlot.tsx";
import { sessionKey } from "../src/layout.ts";
import { makeSession, makeSessionSlotProps } from "./support/fixtures.ts";
import { assertActiveElement, assertNoElement } from "./support/domAssert.ts";
import { createUiSsrHarness, renderComponent } from "./support/ssr.ts";

const mockTerminal: Plugin = {
  name: "copy-menu-terminal", enforce: "pre",
  resolveId(source, importer) {
    return source.endsWith("TerminalPane.tsx") && importer?.includes("/src/") ? "\0copy-menu-terminal" : null;
  },
  load(id) { return id === "\0copy-menu-terminal" ? "export function TerminalPane() { return null; }" : null; },
};
const ssr = createUiSsrHarness([mockTerminal]);
after(async () => ssr.close());
const managedId = "00000000-0000-4000-8000-000000000001";
const providerId = "00000000-0000-4000-8000-000000000002";
const resume = `codex resume ${providerId}`;
const watch = `/watch ${managedId}@testhost`;
type CopyAction = { readonly id: string; readonly label: string; readonly value: string };
// Copy formats beyond core's own action come from UI extensions (#918); these
// cards use a generic watch format.
const watchExtension = { id: "chat", copyFormats: [{ id: "watch", label: "Copy watch command",
  value: (session: { readonly id: string; readonly machine?: string }) => `/watch ${session.id}@${session.machine}` }] };

async function mountCopyCard(mobile: boolean, run: (context: {
  window: Window; writes: string[]; failNext: () => void; remount: () => Promise<void>; interactions: string[];
  deferNext: () => { pending: () => boolean; complete: () => Promise<void> };
  click: (element: Element) => Promise<void>;
  key: (element: Element, key: string) => Promise<void>;
}) => Promise<void>, twoCards = false) {
  const { SessionSlot } = await ssr.loadModule<{ SessionSlot: ComponentType<SessionSlotProps> }>("/src/SessionSlot.tsx");
  const { UiExtensionsProvider, createUiExtensionRegistry } = await ssr.loadModule<typeof import("../src/extensions.tsx")>("/src/extensions.tsx");
  const registry = createUiExtensionRegistry([watchExtension]);
  const { copySessionCardActionToClipboard } = await ssr.loadModule<{
    copySessionCardActionToClipboard: (action: CopyAction, writer: (text: string) => Promise<void>) => Promise<{ ok: boolean }>;
  }>("/src/sessionCardCopy.ts");
  const window = new Window({ url: "http://localhost" });
  const previous = Object.fromEntries(["window", "document", "navigator", "Element", "HTMLElement", "Event", "MouseEvent", "KeyboardEvent", "IS_REACT_ACT_ENVIRONMENT"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries({ window, document: window.document, navigator: window.navigator, Element: window.Element, HTMLElement: window.HTMLElement, Event: window.Event, MouseEvent: window.MouseEvent, KeyboardEvent: window.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: true })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  const writes: string[] = [];
  const interactions: string[] = [];
  let fail = false;
  let deferred: { wait: Promise<void>; started: boolean } | null = null;
  const session = makeSession({ id: managedId, machine: "testhost", provider_resume: { provider: "codex", session_id: providerId } });
  const secondSession = makeSession({ ...session, id: "00000000-0000-4000-8000-000000000003" });
  const sessions = twoCards ? [session, secondSession] : [session];
  function Harness() {
    const [open, setOpen] = useState<string | null>(null);
    const [copied, setCopied] = useState<string | null>(null);
    return sessions.map((cardSession, index) => createElement(SessionSlot, { key: cardSession.id, ...makeSessionSlotProps({ session: cardSession, index, slotMenuKey: `slot-${index}`, slot: sessionKey(cardSession), options: sessions, viewport: { mobile },
      openSlotMenuKey: open, setOpenSlotMenuKey: setOpen, copiedCommandKey: copied,
      onFocusSession: (key) => { interactions.push(key); },
      requestPromptTargetFocus: (key) => { interactions.push(key); },
      copySessionCommand: async (selectedSession, action?: CopyAction) => {
        setCopied(null);
        if (!action) { writes.push("unexpected immediate copy"); return false; }
        const result = await copySessionCardActionToClipboard(action, async (text) => {
          if (fail) { fail = false; throw new Error("fixture clipboard failure"); }
          if (deferred) { deferred.started = true; await deferred.wait; deferred = null; }
          writes.push(text);
        });
        if (result.ok) setCopied(sessionKey(selectedSession));
        return result.ok;
      },
    }) }));
  }
  const click = async (element: Element) => { await act(async () => { element.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true })); }); };
  const key = async (element: Element, key: string) => { await act(async () => {
    element.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
  }); };
  try {
    const mount = (key?: string) => createElement(UiExtensionsProvider, { registry, key }, createElement(Harness));
    await act(async () => root.render(mount()));
    await run({ window, writes, interactions, deferNext: () => {
      let resolve!: () => void;
      const copy = { wait: new Promise<void>((done) => { resolve = done; }), started: false };
      deferred = copy;
      return { pending: () => copy.started, complete: async () => { await act(async () => { resolve(); await copy.wait; }); } };
    }, remount: async () => { await act(async () => root.render(mount("remounted"))); }, failNext: () => { fail = true; }, click, key });
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
}

for (const mobile of [false, true]) {
  test(`copy menu opens without writing, previews exact values, and remembers successful choice (${mobile ? "phone" : "desktop"})`, async () => {
    await mountCopyCard(mobile, async ({ window, writes, click, remount, interactions }) => {
      const body = window.document.body;
      const trigger = body.querySelector(".session-command-copy-button");
      assert.ok(trigger);
      await click(trigger);
      assert.deepEqual(writes, [], "opening must not copy immediately");
      const menu = body.querySelector('[role="menu"][aria-label="Copy session actions"]');
      assert.ok(menu);
      assert.equal(menu.classList.contains("session-copy-sheet"), mobile);
      const items = [...menu.querySelectorAll('[role="menuitem"]')];
      assert.equal(items.length, 2);
      assert.match(items[0]!.textContent!, /Copy resume command/);
      assert.equal(items[0]!.querySelector("code")?.textContent, resume);
      assert.equal(items[1]!.querySelector("code")?.textContent, watch);
      await click(items[1]!);
      assert.deepEqual(writes, [watch]);
      assert.match(body.querySelector(".session-copy-feedback")?.textContent ?? "", /Copied watch command/);
      assertNoElement(body, '[role="menu"][aria-label="Copy session actions"]');
      await remount();
      const freshTrigger = body.querySelector(".session-command-copy-button");
      assert.ok(freshTrigger);
      await click(freshTrigger);
      const reordered = [...body.querySelectorAll('[role="menu"][aria-label="Copy session actions"] [role="menuitem"]')];
      assert.equal(reordered[0]!.querySelector("code")?.textContent, watch);
      await click(reordered[1]!);
      assert.deepEqual(writes, [watch, resume]);
      assert.match(body.querySelector(".session-copy-feedback")?.textContent ?? "", /Copied resume command/);
      assert.deepEqual(interactions, [], "copy controls must not open or focus a session");
      if (mobile) {
        await click(freshTrigger);
        const backdrop = body.querySelector(".session-copy-backdrop");
        assert.ok(backdrop);
        await click(backdrop);
        assertNoElement(body, '[role="menu"][aria-label="Copy session actions"]');
        assert.deepEqual(writes, [watch, resume]);
      }
    });
  });
}

test("copy menu supports Enter, arrows, and Escape without copying on dismissal", async () => {
  await mountCopyCard(false, async ({ window, writes, key }) => {
    const body = window.document.body;
    const trigger = body.querySelector<HTMLElement>(".session-command-copy-button");
    assert.ok(trigger);
    trigger.focus();
    await key(trigger, "Enter");
    const items = [...body.querySelectorAll<HTMLElement>('[role="menu"][aria-label="Copy session actions"] [role="menuitem"]')];
    assert.equal(items.length, 2);
    assertActiveElement(window, items[0]!);
    await key(items[0]!, "ArrowDown");
    assertActiveElement(window, items[1]!);
    await key(items[1]!, "Enter");
    assert.deepEqual(writes, [watch]);
    await key(trigger, "Enter");
    const first = body.querySelector<HTMLElement>('[role="menu"][aria-label="Copy session actions"] [role="menuitem"]');
    assert.ok(first);
    await key(first, "Escape");
    assertNoElement(body, '[role="menu"][aria-label="Copy session actions"]');
    assertActiveElement(window, trigger);
    assert.deepEqual(writes, [watch]);
  });
});

test("a failed copy does not change last-success order or announce success", async () => {
  await mountCopyCard(false, async ({ window, writes, failNext, click }) => {
    const body = window.document.body;
    const trigger = body.querySelector(".session-command-copy-button");
    assert.ok(trigger);
    await click(trigger);
    let items = [...body.querySelectorAll('[role="menu"][aria-label="Copy session actions"] [role="menuitem"]')];
    assert.equal(items.length, 2);
    await click(items[0]!);
    assert.deepEqual(writes, [resume]);
    await click(trigger);
    items = [...body.querySelectorAll('[role="menu"][aria-label="Copy session actions"] [role="menuitem"]')];
    failNext();
    await click(items[1]!);
    assert.deepEqual(writes, [resume]);
    assertNoElement(body, ".session-copy-feedback");
    await click(trigger);
    const first = body.querySelector('[role="menu"][aria-label="Copy session actions"] [role="menuitem"] code');
    assert.equal(first?.textContent, resume);
  });
});


test("copy action list retains profile fallback values and appends registered formats that yield a value (#918)", async () => {
  const { sessionCardCopyActions } = await ssr.loadModule<{
    sessionCardCopyActions: (session: Record<string, unknown>, formats?: readonly unknown[]) => readonly CopyAction[];
  }>("/src/sessionCardCopy.ts");
  const profiled = { id: managedId, machine: "testhost", agent: "claude", agent_profile: "profile", provider_resume: { provider: "claude", session_id: providerId } };
  assert.deepEqual(sessionCardCopyActions(profiled), [
    { id: "provider-session-id", label: "Copy provider session ID", value: providerId },
  ], "core alone offers no watch command");
  assert.deepEqual(sessionCardCopyActions(profiled, watchExtension.copyFormats), [
    { id: "provider-session-id", label: "Copy provider session ID", value: providerId },
    { id: "watch", label: "Copy watch command", value: watch },
  ]);
  const skipped = [null, undefined, "", 42].map((result, index) => ({ id: `skip-${index}`, label: "Copy nothing", value: () => result }));
  assert.deepEqual(sessionCardCopyActions({ id: "short-id", machine: "testhost", agent: "codex" }, skipped), []);
});


test("profile fallback copy feedback names the provider ID", async () => {
  const { SessionSlot } = await ssr.loadModule<{ SessionSlot: ComponentType<SessionSlotProps> }>("/src/SessionSlot.tsx");
  const session = makeSession({ id: "profiled", agent: "claude", agent_profile: "profile", provider_resume: { provider: "claude", session_id: providerId } });
  const html = renderComponent(SessionSlot, makeSessionSlotProps({ session, copiedCommandKey: sessionKey(session) }));
  assert.match(html, /Copied provider session ID/);
  assert.doesNotMatch(html, /Copied resume command/);
});

for (const mobile of [false, true]) {
  test(`deferred copy completion preserves a later card menu and focus (${mobile ? "phone" : "desktop"})`, async () => {
    await mountCopyCard(mobile, async ({ window, writes, click, key, deferNext }) => {
      const body = window.document.body;
      const triggers = [...body.querySelectorAll<HTMLElement>(".session-command-copy-button")];
      assert.equal(triggers.length, 2);
      await click(triggers[0]!);
      const firstItems = [...body.querySelectorAll<HTMLElement>('.session-copy-menu [role="menuitem"]')];
      const held = deferNext();
      await click(firstItems[1]!);
      assert.equal(held.pending(), true, "clipboard write must actually be pending");
      await key(body, "Escape");
      await click(triggers[1]!);
      const laterItem = body.querySelector<HTMLElement>('.session-copy-menu [role="menuitem"]');
      assert.ok(laterItem);
      laterItem.focus();
      assert.equal(triggers[1]!.getAttribute("aria-expanded"), "true");
      await held.complete();
      assert.deepEqual(writes, [watch], "the original successful copy must still finish");
      assert.match(body.querySelector(".session-copy-feedback")?.textContent ?? "", /Copied watch command/);
      assert.equal(window.localStorage.getItem("agent-console.session-copy-action"), "watch");
      assert.equal(triggers[1]!.getAttribute("aria-expanded"), "true", "A completion must leave B menu open");
      assertActiveElement(window, laterItem, "A completion must not steal B focus");
    }, true);
  });
}
