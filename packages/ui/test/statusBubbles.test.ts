import "fake-indexeddb/auto";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { resultStatusNotice, retitleStatusNotice, transientStatusNotice, type StatusNotice } from "../src/statusNoticeModel.ts";
import { TransientNoticeContext } from "../src/transientNotice.ts";
import { SessionRefreshContext, useSessionRefresh, type SessionRefreshOutcome } from "../src/useSessionRefresh.ts";
import { createUiSsrHarness, renderComponent } from "./support/ssr.ts";

// #254: transient results share the top-right status layer; none sits inside the session header.
async function refreshWith(outcome: SessionRefreshOutcome): Promise<StatusNotice[]> {
  const window = new Window({ url: "https://console.test" });
  const previous = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  const shown: StatusNotice[] = [];
  let refresh!: ReturnType<typeof useSessionRefresh>["refresh"];
  function Probe() { refresh = useSessionRefresh().refresh; return null; }
  try {
    await act(async () => {
      root.render(createElement(TransientNoticeContext.Provider, { value: { show: notice => { shown.push(notice); } } },
        createElement(SessionRefreshContext.Provider, { value: { refresh: async () => outcome } }, createElement(Probe))));
    });
    await act(async () => { await refresh({ machine: "fixture", id: "s1" }); });
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
    await window.happyDOM.close();
  }
  return shown;
}

test("a session refresh result goes to the shared top-right notice layer", async () => {
  assert.deepEqual(await refreshWith({ ok: true, changed: ["model"] }), [transientStatusNotice("Session info updated", "ok")]);
  assert.deepEqual(await refreshWith({ ok: false, message: "This host cannot refresh session info yet." }), [
    { kind: "attention", message: "This host cannot refresh session info yet." },
  ]);
});

test("retitle progress and results become shared-layer notices, with the failure reason", () => {
  assert.equal(retitleStatusNotice("working").message, "Retitling…");
  assert.deepEqual(retitleStatusNotice("committed"), transientStatusNotice("Title updated", "ok"));
  assert.equal(retitleStatusNotice("unchanged").message, "No change");
  assert.equal(retitleStatusNotice("degraded_cached").message, "Cached title kept");
  assert.deepEqual(retitleStatusNotice("terminal_failure", "The session history moved. Try again."), {
    kind: "attention", message: "Retitle failed: The session history moved. Try again.",
  });
  assert.equal(retitleStatusNotice("failed").message, "Retitle failed");
});

test("the shared layer renders a transient notice politely with a readable label", async () => {
  const harness = createUiSsrHarness();
  try {
    const { StatusNotice: Notice } = await harness.loadModule<typeof import("../src/StatusNotice.tsx")>("/src/StatusNotice.tsx");
    const html = renderComponent(Notice, { notice: transientStatusNotice("Session info updated", "ok"), onDismiss() {}, inline: true });
    assert.match(html, /class="connection-notice is-transient is-tone-ok"/);
    assert.match(html, /role="status"/);
    assert.match(html, />Session info updated</);
  } finally { await harness.close(); }
});

test("no transient result is rendered inside the session header; the dashboard owns the one layer", () => {
  const slot = readFileSync(new URL("../src/SessionSlot.tsx", import.meta.url), "utf8");
  const dashboard = readFileSync(new URL("../src/Dashboard.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(slot, /retitle-feedback|shortcutHint|Session info updated/);
  assert.match(dashboard, /<TransientNoticeContext\.Provider value=\{transientNoticeControl\}>/);
  assert.match(dashboard, /const visibleStatusNotice = statusNotice \?\? resultNotice \?\?/);
  assert.match(dashboard, /isLive: \(key\) => liveSessionKeys\.has\(key\)/);
});

test("a retitle still pending for a session that left the list leaves no stale progress behind", () => {
  const live = new Set(["host:a", "host:b"]);
  const pick = (retitle: { key: string; state: "working" | "updated" } | null, shortcut: { key: string; text: string } | null) =>
    resultStatusNotice({ transient: null, retitle, shortcut, isLive: key => live.has(key) });
  assert.equal(pick({ key: "host:a", state: "working" }, null)?.message, "Retitling…");
  live.delete("host:a");
  assert.equal(pick({ key: "host:a", state: "working" }, null), null, "the removed session's pending retitle is dropped");
  assert.equal(pick({ key: "host:a", state: "working" }, { key: "host:b", text: "Open a session" })?.message, "Open a session", "the next notice is not masked");
  assert.equal(pick({ key: "host:a", state: "updated" }, null), null, "a result resolving after removal shows nothing");
  assert.equal(resultStatusNotice({ transient: transientStatusNotice("Session info updated", "ok"), retitle: { key: "host:a", state: "working" }, shortcut: null, isLive: () => false })?.message, "Session info updated");
});
