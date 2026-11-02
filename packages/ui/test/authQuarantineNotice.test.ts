import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import type { Plugin } from "vite";
import type { SessionSlotProps } from "../src/SessionSlot.tsx";
import type { Session } from "../src/types.ts";
import { makeSession, makeSessionSlotProps } from "./support/fixtures.ts";
import { createUiSsrHarness } from "./support/ssr.ts";

const terminalMock: Plugin = {
  name: "mock-terminal-pane",
  enforce: "pre",
  resolveId(source, importer) {
    return source.endsWith("TerminalPane.tsx") && importer?.includes("/src/") ? "\0terminal-pane-mock" : null;
  },
  load(id) {
    return id === "\0terminal-pane-mock"
      ? 'import React from "react"; export function TerminalPane() { return React.createElement("div", { className: "terminal-pane-mock" }); }'
      : null;
  },
};
const ssr = createUiSsrHarness([terminalMock]);
after(async () => { await ssr.close(); });

const boundClaude = {
  schema_version: "agent-session.claude-account.v1", supported: true, state: "bound", selected_account: "alpha",
  selection_source: "explicit", revision: 2, applied_runtime_id: "launch-hs-1",
} as const;
const quarantined = { auth_incident: { status: "auth_failed" } } as const;
const claude = (overrides: Partial<Session> = {}) =>
  makeSession({ agent: "claude", claude_account: boundClaude, ...quarantined, ...overrides });

async function mount(session: () => Session, onReverify: SessionSlotProps["onReverify"], view: "terminal" | "conversation") {
  const { SessionSlot } = await ssr.loadModule<{ SessionSlot: ComponentType<SessionSlotProps> }>("/src/SessionSlot.tsx");
  const window = new Window({ url: "http://localhost" });
  const previous = { window: globalThis.window, document: globalThis.document, Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement, Event: globalThis.Event, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window, document: window.document, Element: window.Element,
    HTMLElement: window.HTMLElement, Event: window.Event, IS_REACT_ACT_ENVIRONMENT: true });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  const render = async () => {
    const current = session();
    const props = makeSessionSlotProps({ session: current, options: [current], onReverify });
    await act(async () => root.render(createElement(SessionSlot, view === "conversation"
      ? { ...props, view: { ...props.view, sessionListDisplay: "conversation" as const } } : props)));
  };
  await render();
  return {
    container, render,
    button: () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === "Re-verify"),
    notice: () => container.querySelector('[data-testid="auth-quarantine"]')?.textContent ?? "",
    async close() { await act(async () => root.unmount()); Object.assign(globalThis, previous); window.close(); },
  };
}

for (const view of ["terminal", "conversation"] as const) {
  test(`${view}: a quarantined bound Claude session names the cause and offers one Re-verify`, async () => {
    const seen: Session[] = [];
    const h = await mount(() => claude(), async s => { seen.push(s); return null; }, view);
    try {
      assert.match(h.notice(), /authentication quarantine/i);
      assert.equal(h.container.querySelectorAll("button").length > 0 && [...h.container.querySelectorAll("button")].filter(b => b.textContent === "Re-verify").length, 1);
      await act(async () => h.button()!.click());
      assert.equal(seen.length, 1);
      assert.equal(seen[0]!.claude_account?.state === "bound" && seen[0]!.claude_account.selected_account, "alpha");
      assert.match(h.notice(), /not released/i, "the refreshed session still reports the incident");
    } finally { await h.close(); }
  });
}

test("a refused Re-verify shows the edge's safe text and keeps the action", async () => {
  const h = await mount(() => claude(), async () => "the account credentials have not been republished yet; the authentication quarantine was left unchanged", "terminal");
  try {
    await act(async () => h.button()!.click());
    assert.match(h.notice(), /have not been republished yet/);
    assert.ok(h.button());
  } finally { await h.close(); }
});

test("the notice disappears once the refreshed session carries no quarantining incident", async () => {
  let session = claude();
  const h = await mount(() => session, async () => { session = claude({ auth_incident: { status: "recovered" } }); return null; }, "terminal");
  try {
    await act(async () => h.button()!.click());
    await h.render();
    assert.equal(h.notice(), "");
    assert.equal(h.button(), undefined);
  } finally { await h.close(); }
});

for (const [name, session] of [
  ["a Codex session", makeSession({ agent: "codex", ...quarantined })],
  ["an unbound Claude session", claude({ claude_account: { ...boundClaude, state: "unbound", selected_account: undefined } as Session["claude_account"] })],
] as const) {
  test(`${name} shows the cause without a Re-verify action`, async () => {
    const h = await mount(() => session, async () => null, "terminal");
    try {
      assert.match(h.notice(), /authentication quarantine/i);
      assert.equal(h.button(), undefined);
    } finally { await h.close(); }
  });
}

test("a session without a quarantining incident shows no notice", async () => {
  const h = await mount(() => claude({ auth_incident: undefined }), async () => null, "terminal");
  try { assert.equal(h.notice(), ""); } finally { await h.close(); }
});
