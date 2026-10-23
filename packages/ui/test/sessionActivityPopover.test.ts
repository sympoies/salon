import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { after, afterEach, test } from "node:test";
import { Window } from "happy-dom";
import { createElement, type ComponentType } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SessionActivityPopoverProps } from "../src/SessionActivityPopover.tsx";
import { assertActiveElement, assertNoElement } from "./support/domAssert.ts";
import { makeSession } from "./support/fixtures.ts";
import { createUiSsrHarness } from "./support/ssr.ts";

const cleanupStack: Array<() => Promise<void>> = [];
const ssr = createUiSsrHarness();

after(async () => ssr.close());

afterEach(async () => {
  while (cleanupStack.length > 0) await cleanupStack.pop()?.();
});

function installDom(): { window: Window; root: Root; container: HTMLElement; cleanup(): Promise<void> } {
  const window = new Window({ url: "http://localhost" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    KeyboardEvent: globalThis.KeyboardEvent,
    MouseEvent: globalThis.MouseEvent,
    Event: globalThis.Event,
    navigatorDescriptor: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window,
    document: window.document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    KeyboardEvent: window.KeyboardEvent,
    MouseEvent: window.MouseEvent,
    Event: window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  return {
    window,
    root,
    container,
    async cleanup() {
      await act(async () => root.unmount());
      const { navigatorDescriptor, ...globals } = previous;
      Object.assign(globalThis, globals);
      if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
      else delete (globalThis as { navigator?: Navigator }).navigator;
      window.close();
    },
  };
}

function fixture() {
  const nowMs = Date.parse("2026-07-10T12:10:00Z");
  const session = makeSession({
    created_at: "2026-07-10T11:00:00Z",
    activity_observed_at: "2026-07-10T12:10:00Z",
    runtime_started_at: "2026-07-10T11:44:02Z",
    turn_state: {
      schema_version: "agent-session.turn-state.v1",
      phase: "needs_input",
      phase_changed_at: "2026-07-10T12:09:18Z",
      revision: 4,
      source: { kind: "provider_hook", provider: "codex", confidence: "observed" },
      current_turn: {
        started_at: "2026-07-10T12:07:46Z",
        last_progress_at: "2026-07-10T12:09:30Z",
        attention: {
          kind: "clarification",
          requested_at: "2026-07-10T12:09:18Z",
          pending_count: 1,
          certainty: "exact",
        },
      },
    },
  });
  return { session, nowMs };
}

async function renderPopover(input: Partial<SessionActivityPopoverProps> = {}) {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const props = fixture();
  const module = await ssr.loadModule<{
    SessionActivityPopover: ComponentType<SessionActivityPopoverProps>;
  }>("/src/SessionActivityPopover.tsx");
  await act(async () => {
    mounted.root.render(
      createElement(module.SessionActivityPopover, {
        ...props,
        machineReachable: true,
        focused: true,
        terminalStatus: "open",
        ...input,
      }),
    );
  });
  return mounted;
}

for (const [agent, provider] of [["codex", "Codex"], ["claude", "Claude"]]) {
  test(`Activity identities distinguish ${provider} IDs and report exact copy only after success`, async () => {
    const managedId = `managed-${agent}-exact-full-identifier`;
    const providerId = `${agent}-conversation-exact-full-identifier`;
    const mounted = await renderPopover({ session: makeSession({
      id: managedId, agent, provider_resume: { provider: agent, session_id: providerId },
    }) });
    const writes: string[] = [];
    let completeWrite!: () => void;
    const pending = new Promise<void>(resolve => { completeWrite = resolve; });
    Object.defineProperty(mounted.window.navigator, "clipboard", { configurable: true, value: {
      writeText: (text: string) => { writes.push(text); return writes.length === 1 ? pending : Promise.resolve(); },
    } });
    await act(async () => mounted.container.querySelector<HTMLButtonElement>(".session-activity-trigger")!
      .dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true })));
    const managed = mounted.container.querySelector<HTMLButtonElement>('button[aria-label="Copy Agent-session ID"]');
    const conversation = mounted.container.querySelector<HTMLButtonElement>(`button[aria-label="Copy ${provider} provider session ID"]`);
    assert.ok(managed && conversation, "both identities have distinct keyboard-accessible buttons");
    assert.equal(managed.textContent, managedId);
    assert.equal(conversation.textContent, providerId);
    await act(async () => managed.dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true })));
    assert.deepEqual(writes, [managedId]);
    assert.doesNotMatch(mounted.container.querySelector('[role="dialog"]')?.textContent ?? "", /Copied/);
    assert.equal(managed.getAttribute("aria-disabled"), "true", "pending state remains accessible and focusable");
    await act(async () => managed.dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true })));
    assert.deepEqual(writes, [managedId], "pending copy cannot repeat");
    await act(async () => completeWrite());
    assert.match(managed.closest(".session-activity-row")?.textContent ?? "", /Copied/);
    await act(async () => conversation.dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true })));
    assert.deepEqual(writes, [managedId, providerId]);
    assert.match(conversation.closest(".session-activity-row")?.textContent ?? "", /Copied/);
    assert.ok(mounted.container.querySelector('[role="dialog"]'), "copy does not dismiss the panel");
  });
}

for (const providerResume of [null, { provider: "claude" }]) {
  test(`Activity identities keep missing provider ID unavailable (${providerResume?.provider ?? "absent"})`, async () => {
    const mounted = await renderPopover({ session: makeSession({ id: "managed-only", provider_resume: providerResume }) });
    await act(async () => mounted.container.querySelector<HTMLButtonElement>(".session-activity-trigger")!
      .dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true })));
    const row = [...mounted.container.querySelectorAll(".session-activity-row")]
      .find(element => element.querySelector(".session-activity-label")?.textContent?.startsWith("Provider session ID"));
    assert.ok(row, "missing identity still has its own field");
    assert.equal(row.querySelector(".session-activity-value")?.textContent, "Unavailable");
    assertNoElement(row, "button", "missing provider identity is not copyable or substituted");
    assert.equal(mounted.container.querySelector('button[aria-label="Copy Agent-session ID"]')?.textContent, "managed-only");
  });
}

test("Activity identities use the existing macOS clipboard writer", async () => {
  const mounted = await renderPopover({ session: makeSession({ id: "native-full-identity" }) });
  const writes: Array<{ command: string; text: string }> = [];
  Object.defineProperty(mounted.window, "__TAURI_INTERNALS__", { configurable: true, value: {
    invoke: async (command: string, args: { text: string }) => { writes.push({ command, text: args.text }); },
  } });
  Object.defineProperty(mounted.window.navigator, "clipboard", { configurable: true, value: {
    writeText: async () => { throw new Error("native fixture must not use browser clipboard"); },
  } });
  await act(async () => mounted.container.querySelector<HTMLButtonElement>(".session-activity-trigger")!
    .dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true })));
  const button = mounted.container.querySelector<HTMLButtonElement>('button[aria-label="Copy Agent-session ID"]');
  assert.ok(button);
  await act(async () => button.dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true })));
  assert.deepEqual(writes, [{ command: "write_macos_clipboard_text", text: "native-full-identity" }]);
  assert.match(button.closest(".session-activity-row")?.textContent ?? "", /Copied/);
});

test("Activity identities keep a preview open when fallback copy moves focus outside", async () => {
  const mounted = await renderPopover({ session: makeSession({ id: "fallback-full-identity" }) });
  const writes: string[] = [];
  Object.defineProperty(mounted.window.navigator, "clipboard", { configurable: true, value: undefined });
  Object.defineProperty(mounted.window.document, "execCommand", { configurable: true, value: () => {
    const textarea = mounted.window.document.querySelector<HTMLTextAreaElement>("textarea")!;
    textarea.focus();
    writes.push(textarea.value);
    return true;
  } });
  const popupRoot = mounted.container.querySelector<HTMLElement>(".session-activity-root")!;
  await act(async () => {
    popupRoot.dispatchEvent(new mounted.window.MouseEvent("mouseover", { bubbles: true }));
    await new Promise(resolve => mounted.window.setTimeout(resolve, 300));
  });
  assert.ok(mounted.container.querySelector('[role="tooltip"]'));
  const button = mounted.container.querySelector<HTMLButtonElement>('button[aria-label="Copy Agent-session ID"]');
  assert.ok(button);
  await act(async () => button.focus());
  await act(async () => button.dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true })));
  await act(async () => { await new Promise(resolve => mounted.window.setTimeout(resolve, 150)); });
  assert.deepEqual(writes, ["fallback-full-identity"]);
  assert.ok(mounted.container.querySelector('[role="dialog"]'), "copy pins the preview despite temporary fallback focus");
  assert.match(mounted.container.textContent ?? "", /Copied/);
});

test("Activity identities retain the exact selectable value after clipboard rejection", async () => {
  const mounted = await renderPopover({ session: makeSession({ id: "copy-rejected-full-id" }) });
  Object.defineProperty(mounted.window.navigator, "clipboard", { configurable: true, value: {
    writeText: async () => { throw new Error("fixture clipboard denied"); },
  } });
  await act(async () => mounted.container.querySelector<HTMLButtonElement>(".session-activity-trigger")!
    .dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true })));
  const button = mounted.container.querySelector<HTMLButtonElement>('button[aria-label="Copy Agent-session ID"]');
  assert.ok(button);
  await act(async () => button.dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true })));
  assert.equal(button.textContent, "copy-rejected-full-id");
  assert.equal(button.disabled, false);
  assert.match(button.closest(".session-activity-row")?.textContent ?? "", /Copy failed/);
  assert.doesNotMatch(button.closest(".session-activity-row")?.textContent ?? "", /Copied/);
  assert.ok(mounted.container.querySelector('[role="dialog"]'));
});

for (const machineReachable of [true, false]) {
  test(`missing timing keeps the activity header icon alone (reachable=${machineReachable})`, async () => {
    const mounted = await renderPopover({
      session: makeSession({ status: "stopped", created_at: undefined, updated_at: undefined,
        runtime_started_at: undefined, last_terminal_activity_at: undefined, activity_observed_at: undefined, turn_state: null }),
      machineReachable, focused: false,
    });
    const trigger = mounted.container.querySelector<HTMLButtonElement>(".session-activity-trigger")!;
    assert.equal(trigger.querySelector(".session-activity-text")?.textContent ?? "", "");
    assert.ok(trigger.querySelector(".session-activity-marker"), "state icon remains identifiable");
    assert.ok(trigger.getAttribute("aria-label")?.startsWith("Session activity:"), "details remain accessible");
  });
}

test("Working header keeps continuous phase age while current turn details advance", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const module = await ssr.loadModule<{ SessionActivityPopover: ComponentType<SessionActivityPopoverProps> }>("/src/SessionActivityPopover.tsx");
  const { nowMs } = fixture();
  for (const age of [180, 90, 53]) {
    await act(async () => mounted.root.render(createElement(module.SessionActivityPopover, {
      session: makeSession({ turn_state: {
        schema_version: "agent-session.turn-state.v1", phase: "working", phase_changed_at: "2026-07-10T11:27:00Z", revision: age,
        source: { kind: "provider_hook", provider: "codex", confidence: "observed" },
        semantic_event: { kind: "turn_started", observed_at: new Date(nowMs - age * 1000).toISOString() },
        current_turn: { started_at: new Date(nowMs - age * 1000).toISOString() },
      } }), nowMs, machineReachable: true, focused: false,
    })));
    const trigger = mounted.container.querySelector<HTMLButtonElement>(".session-activity-trigger")!;
    assert.equal(trigger.querySelector(".session-activity-text")?.textContent, "43m");
    assert.equal(trigger.getAttribute("aria-label"), "Session activity: Working 43m");
    if (trigger.getAttribute("aria-expanded") !== "true") {
      await act(async () => trigger.dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true })));
    }
    const row = [...mounted.container.querySelectorAll(".session-activity-row")].find(el => el.querySelector(".session-activity-label")?.textContent === "Current turn");
    assert.ok(row?.querySelector(".session-activity-value")?.textContent?.endsWith(age === 180 ? "3m ago" : age === 90 ? "1m 30s ago" : "53s ago"));
  }
});

test("failed waiting turns render the card status chip as Attention", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const module = await ssr.loadModule<{ SessionActivityPopover: ComponentType<SessionActivityPopoverProps> }>("/src/SessionActivityPopover.tsx");
  const session = makeSession({ status: "running", turn_state: {
    schema_version: "agent-session.turn-state.v1", phase: "waiting", phase_changed_at: "2026-07-10T12:09:18Z", revision: 5,
    source: { kind: "provider_hook", provider: "codex", confidence: "observed" },
    last_turn: { started_at: "2026-07-10T12:07:46Z", completed_at: "2026-07-10T12:09:18Z", outcome: "failed" },
  } });
  await act(async () => mounted.root.render(createElement(module.SessionActivityPopover, {
    session, nowMs: Date.parse("2026-07-10T12:10:00Z"), machineReachable: true, focused: false,
  })));
  const trigger = mounted.container.querySelector<HTMLButtonElement>(".session-activity-trigger")!;
  assert.ok(trigger.classList.contains("card-state-blocked"));
  assert.equal(trigger.getAttribute("aria-label"), "Session activity: Blocked: provider failed");
});

// #937: a usage-limit failure read as "Waiting" in the details; the current state names the failure.
test("failed turn details read Failed, with the daemon's failure kind when sent", async () => {
  const module = await ssr.loadModule<{ SessionActivityPopover: ComponentType<SessionActivityPopoverProps> }>("/src/SessionActivityPopover.tsx");
  for (const [kind, state, aria] of [
    [undefined, "Failed 42s", "Session activity: Blocked: provider failed"],
    ["authentication", "Failed (sign-in required) 42s", "Session activity: Blocked: provider failed (sign-in required)"],
  ] as const) {
    const mounted = installDom();
    cleanupStack.push(mounted.cleanup);
    const session = makeSession({ status: "running", turn_state: {
      schema_version: "agent-session.turn-state.v1", phase: "waiting", phase_changed_at: "2026-07-10T12:09:18Z", revision: 5,
      source: { kind: "provider_hook", provider: "codex", confidence: "authoritative" },
      last_turn: { started_at: "2026-07-10T12:07:46Z", completed_at: "2026-07-10T12:09:18Z", outcome: "failed", ...(kind ? { provider_failure_kind: kind } : {}) },
    } });
    await act(async () => mounted.root.render(createElement(module.SessionActivityPopover, {
      session, nowMs: Date.parse("2026-07-10T12:10:00Z"), machineReachable: true, focused: false,
    })));
    const trigger = mounted.container.querySelector<HTMLButtonElement>(".session-activity-trigger")!;
    assert.equal(trigger.getAttribute("aria-label"), aria);
    await act(async () => trigger.dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true })));
    const row = [...mounted.container.querySelectorAll(".session-activity-row")].find(el => el.querySelector(".session-activity-label")?.textContent === "Current state");
    assert.equal(row?.querySelector(".session-activity-value")?.textContent, state);
  }
});

test("activity trigger pins metadata-only details and dismisses with Escape", async () => {
  const mounted = await renderPopover();
  const trigger = mounted.container.querySelector<HTMLButtonElement>(".session-activity-trigger");
  assert.ok(trigger);
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(
    trigger.getAttribute("aria-label"),
    "Session activity: Needs input: clarification requested; Working 2m 14s; input requested 42s; 1 pending",
  );
  assert.equal(
    trigger.querySelector(".session-activity-text")?.textContent,
    "0m",
    "a pending request is timed from the request (42s), not the turn start (#873)",
  );
  assertNoElement(mounted.container, ".session-activity-attention", "card row contains only icon and time");

  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  const dialog = mounted.container.querySelector('[role="dialog"]');
  assert.ok(dialog);
  assertActiveElement(mounted.window, dialog);
  assert.match(dialog.textContent ?? "", /Working 2m 14s/);
  assert.match(dialog.textContent ?? "", /Input requested 42s/);
  assert.match(dialog.textContent ?? "", /Observed/);
  assert.match(dialog.textContent ?? "", /Clarification/);
  assert.doesNotMatch(dialog.textContent ?? "", /prompt|assistant|tool input|tool output/i);

  await act(async () => {
    mounted.window.document.dispatchEvent(
      new mounted.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });
  assertNoElement(mounted.container, '[role="dialog"]');
  assertActiveElement(mounted.window, trigger);
});

test("exact clear removes attention and starts the new Working phase timer", async () => {
  const mounted = await renderPopover();
  const module = await ssr.loadModule<{
    SessionActivityPopover: ComponentType<SessionActivityPopoverProps>;
  }>("/src/SessionActivityPopover.tsx");
  const { session, nowMs } = fixture();
  const cleared = {
    ...session,
    turn_state: {
      ...session.turn_state,
      phase: "working",
      phase_changed_at: "2026-07-10T12:09:31Z",
      current_turn: {
        started_at: "2026-07-10T12:07:46Z",
        last_progress_at: "2026-07-10T12:09:31Z",
      },
    },
  };
  await act(async () => {
    mounted.root.render(
      createElement(module.SessionActivityPopover, {
        session: cleared,
        nowMs,
        machineReachable: true,
        focused: true,
        terminalStatus: "open",
      }),
    );
  });

  const trigger = mounted.container.querySelector<HTMLButtonElement>(".session-activity-trigger");
  assert.ok(trigger);
  assert.match(trigger.className, /activity-working/);
  assert.equal(trigger.getAttribute("aria-label"), "Session activity: Working 29s");
  assertNoElement(mounted.container, ".session-activity-attention");
  assert.equal(
    trigger.querySelector(".session-activity-text")?.textContent,
    "0m",
  );
});

test("dismissing the attention pill hides it until a new attention arrives", async () => {
  const mounted = await renderPopover();
  const module = await ssr.loadModule<{
    SessionActivityPopover: ComponentType<SessionActivityPopoverProps>;
  }>("/src/SessionActivityPopover.tsx");
  const { session, nowMs } = fixture();

  await act(async () => {
    mounted.container.querySelector<HTMLButtonElement>(".session-activity-trigger")!.dispatchEvent(new mounted.window.MouseEvent("click", {bubbles:true}));
  });
  const dismiss = mounted.container.querySelector<HTMLButtonElement>(".session-activity-attention-dismiss");
  assert.ok(dismiss, "the attention pill exposes a dismiss control");
  assert.match(dismiss.getAttribute("aria-label") ?? "", /dismiss/i);

  await act(async () => {
    dismiss.dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  assertNoElement(mounted.container, ".session-activity-attention", "clicking dismiss suppresses the pill");
  const trigger = mounted.container.querySelector<HTMLButtonElement>(".session-activity-trigger");
  assert.ok(trigger);
  assert.equal(trigger.querySelector(".session-activity-text")?.textContent, "2m");
  assert.doesNotMatch(trigger.textContent ?? "", /Input requested/);

  // A new attention (different requested_at + pending_count) must reappear so a
  // fresh input request is never silently muted by the stale dismissal.
  const renewed = {
    ...session,
    turn_state: {
      ...session.turn_state,
      current_turn: {
        ...session.turn_state.current_turn,
        last_progress_at: "2026-07-10T12:09:50Z",
        attention: {
          kind: "clarification",
          requested_at: "2026-07-10T12:09:45Z",
          pending_count: 4,
          certainty: "exact",
        },
      },
    },
  };
  await act(async () => {
    mounted.root.render(
      createElement(module.SessionActivityPopover, {
        session: renewed,
        nowMs,
        machineReachable: true,
        focused: true,
        terminalStatus: "open",
      }),
    );
  });
  const restored = mounted.container.querySelector(".session-activity-attention");
  assert.ok(restored, "a new attention fingerprint restores the pill");
  assert.match(restored.textContent ?? "", /Input requested/);
});

test("focusing a completed session acknowledges only that completion on this device", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const module = await ssr.loadModule<{
    SessionActivityPopover: ComponentType<SessionActivityPopoverProps>;
  }>("/src/SessionActivityPopover.tsx");
  const nowMs = Date.parse("2026-07-10T12:10:00Z");
  const completed = makeSession({
    machine: "summit",
    id: "completed-1",
    activity_observed_at: "2026-07-10T12:10:00Z",
    session_incarnation: "incarnation-a",
    turn_state: {
      schema_version: "agent-session.turn-state.v1",
      phase: "waiting",
      phase_changed_at: "2026-07-10T12:09:00Z",
      revision: 8,
      source: { kind: "provider_hook", provider: "codex", confidence: "authoritative" },
      last_turn: {
        provider_turn_id: "turn-8",
        completed_at: "2026-07-10T12:09:00Z",
        outcome: "completed",
      },
    },
  });

  await act(async () => {
    mounted.root.render(createElement(module.SessionActivityPopover, {
      session: completed,
      machineReachable: true,
      focused: true,
      nowMs,
    }));
  });
  assert.equal(
    mounted.container.querySelector(".session-activity-trigger")?.textContent?.trim(),
    "1m",
  );
  assert.match(
    mounted.window.localStorage.getItem("agent-console.activity-acknowledgements.v1") ?? "",
    /completed-1/,
  );

  await act(async () => {
    mounted.root.render(createElement(module.SessionActivityPopover, {
      session: {
        ...completed,
        turn_state: {
          ...completed.turn_state,
          revision: 9,
          last_turn: {
            provider_turn_id: "turn-9",
            completed_at: "2026-07-10T12:09:50Z",
            outcome: "completed",
          },
        },
      },
      machineReachable: true,
      focused: false,
      nowMs,
    }));
  });
  assert.equal(
    mounted.container.querySelector(".session-activity-trigger")?.textContent?.trim(),
    "0m",
  );
  assert.match(
    mounted.container.querySelector(".session-activity-trigger")?.getAttribute("aria-label") ?? "",
    /Done 10s/,
  );
});

test("a failed device-local acknowledgement write does not hide Done", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const module = await ssr.loadModule<{
    SessionActivityPopover: ComponentType<SessionActivityPopoverProps>;
  }>("/src/SessionActivityPopover.tsx");
  const completed = makeSession({
    machine: "summit",
    id: "storage-failure",
    session_incarnation: "incarnation-storage-failure",
    turn_state: {
      schema_version: "agent-session.turn-state.v1",
      phase: "waiting",
      phase_changed_at: "2026-07-10T12:09:00Z",
      revision: 8,
      source: { kind: "provider_hook", provider: "codex", confidence: "authoritative" },
      last_turn: {
        provider_turn_id: "turn-storage-failure",
        completed_at: "2026-07-10T12:09:00Z",
        outcome: "completed",
      },
    },
  });
  Object.defineProperty(mounted.window.localStorage, "setItem", {
    configurable: true,
    value: () => {
      throw new Error("storage unavailable");
    },
  });

  await act(async () => {
    mounted.root.render(createElement(module.SessionActivityPopover, {
      session: completed,
      machineReachable: true,
      focused: true,
      nowMs: Date.parse("2026-07-10T12:10:00Z"),
    }));
  });

  assert.match(
    mounted.container.querySelector(".session-activity-trigger")?.getAttribute("aria-label") ?? "",
    /Done 1m/,
  );
});

test("mixed activity CSS keeps non-color cues and honors reduced motion", async () => {
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.session-activity-attention\s*\{[\s\S]*?border:\s*1px solid var\(--warn\)/);
  assert.match(css, /\.session-activity-attention-mark[\s\S]*?font-weight:\s*var\(--weight-heavy\)/);
  assert.match(
    css,
    /\.session-activity-trigger\.activity-working-uncertain\.has-ripple \.session-activity-marker::after\s*\{[^}]*border-color:\s*var\(--warn\)/,
  );
  const reducedMotion = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(
    reducedMotion,
    /\.activity-working \.session-activity-glyph,\s*\.activity-working-attention \.session-activity-glyph,[^{]*\{[^}]*animation:\s*none/,
  );
  assert.match(css, /\.terminal-slot\s*\{[^}]*container-type:\s*inline-size[^}]*container-name:\s*terminal-slot/);
  assert.match(
    css,
    /@container terminal-slot \(max-width: 420px\)\s*\{\s*\.session-activity-attention-copy\s*\{[^}]*display:\s*none/,
  );
  assert.match(css, /\.session-workspace\.mobile \.session-activity-attention-copy[\s\S]*?display:\s*none/);
});

test("keyboard focus opens an associated tooltip and blur closes it", async () => {
  const mounted = await renderPopover();
  const trigger = mounted.container.querySelector<HTMLButtonElement>(".session-activity-trigger");
  assert.ok(trigger);
  assert.equal(trigger.getAttribute("aria-haspopup"), "dialog");

  await act(async () => {
    trigger.focus();
    await new Promise((resolve) => mounted.window.setTimeout(resolve, 300));
  });
  const tooltip = mounted.container.querySelector<HTMLElement>('[role="tooltip"]');
  assert.ok(tooltip);
  assert.equal(trigger.getAttribute("aria-describedby"), tooltip.id);

  const outside = mounted.window.document.createElement("button");
  mounted.window.document.body.append(outside);
  await act(async () => {
    outside.focus();
    await new Promise((resolve) => mounted.window.setTimeout(resolve, 150));
  });
  assertNoElement(mounted.container, '[role="tooltip"]');
});

test("hover preview is delayed while click-pinned content survives pointer leave and closes outside", async () => {
  const mounted = await renderPopover();
  const root = mounted.container.querySelector<HTMLElement>(".session-activity-root");
  const trigger = mounted.container.querySelector<HTMLButtonElement>(".session-activity-trigger");
  assert.ok(root && trigger);

  await act(async () => {
    root.dispatchEvent(new mounted.window.MouseEvent("mouseover", { bubbles: true }));
    await new Promise((resolve) => mounted.window.setTimeout(resolve, 300));
  });
  assert.ok(mounted.container.querySelector('[role="tooltip"]'));

  await act(async () => {
    trigger.dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  assert.ok(mounted.container.querySelector('[role="dialog"]'));
  await act(async () => {
    root.dispatchEvent(new mounted.window.MouseEvent("mouseout", { bubbles: true }));
    await new Promise((resolve) => mounted.window.setTimeout(resolve, 150));
  });
  assert.ok(mounted.container.querySelector('[role="dialog"]'));

  const outside = mounted.window.document.createElement("button");
  mounted.window.document.body.append(outside);
  await act(async () => {
    outside.dispatchEvent(new mounted.window.Event("pointerdown", { bubbles: true, cancelable: true }));
  });
  assertNoElement(mounted.container, '[role="dialog"]');
});

test("desktop popovers stay inside the viewport and recompute after resize", async () => {
  const mounted = await renderPopover();
  let left = -110;
  let position = "absolute";
  const originalRect = mounted.window.HTMLElement.prototype.getBoundingClientRect;
  const originalComputedStyle = mounted.window.getComputedStyle.bind(mounted.window);
  mounted.window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.classList.contains("session-activity-popover")) {
      return { left, right: left + 360, width: 360, top: 50, bottom: 300, height: 250, x: left, y: 50, toJSON() {} };
    }
    return originalRect.call(this);
  };
  mounted.window.getComputedStyle = ((element: Element) => {
    const style = originalComputedStyle(element);
    if (element.classList.contains("session-activity-popover")) {
      Object.defineProperty(style, "position", { value: position });
    }
    return style;
  }) as typeof mounted.window.getComputedStyle;
  const trigger = mounted.container.querySelector(".session-activity-trigger")!;
  await act(async () => {
    trigger.dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true }));
  });
  const popover = mounted.container.querySelector<HTMLElement>(".session-activity-popover")!;
  assert.equal(popover.style.transform, "translateX(118px)");
  left = mounted.window.innerWidth - 200;
  await act(async () => mounted.window.dispatchEvent(new mounted.window.Event("resize")));
  assert.equal(popover.style.transform, "translateX(-168px)");
  left = 100;
  await act(async () => mounted.window.dispatchEvent(new mounted.window.Event("resize")));
  assert.equal(popover.style.transform, "");
  position = "fixed";
  left = -110;
  await act(async () => mounted.window.dispatchEvent(new mounted.window.Event("resize")));
  assert.equal(popover.style.transform, "", "mobile bottom sheets keep their safe-area positioning");
});
