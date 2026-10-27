import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import type { Plugin } from "vite";
import { makeSession } from "./fixtures.ts";
import { createUiSsrHarness, renderComponent } from "./ssr.ts";

export type NoticeSurface = "dashboard" | "shell";
const machine = "very-long-production-machine-name";

/** Mount production surfaces, mocking only transport and the terminal renderer. */
export async function renderNoticeSurface(surface: NoticeSurface, width: number, connection?: {
  readonly restore: boolean;
  readonly error?: string;
  readonly conversationUnavailable?: boolean;
  readonly focusedConversation?: boolean;
  readonly focused?: boolean;
  readonly phoneFocusCounts?: boolean;
  readonly macTitleBar?: boolean;
  readonly inspectActive?: (container: HTMLElement, active: boolean) => void;
  readonly inspectClear?: (container: HTMLElement, phase: "initial" | "dismissed") => void;
  readonly inspect?: (container: HTMLElement, phase: "unreachable" | "restored") => void;
}): Promise<string> {
  const window = new Window({ url: connection?.macTitleBar ? "http://tauri.localhost" : "http://localhost", width, height: 800 });
  const globals = { window, document: window.document, Element: window.Element, HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement, HTMLSelectElement: window.HTMLSelectElement,
    __agentConsoleNoticePoll: undefined, __agentConsoleNoticeOutage: false, localStorage: window.localStorage, navigator: window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  const apiNames = [...readFileSync(new URL("../../src/api.ts", import.meta.url), "utf8")
    .matchAll(/^export (?:async )?function (\w+)/gm)].map(match => match[1]);
  const sessions = [makeSession({ machine, id: "one", turn_state: {
    schema_version: "agent-session.turn-state.v1", phase: "working", phase_changed_at: "2030-01-01T00:00:00Z",
    revision: 1, source: { kind: "runtime", confidence: "observed" },
  } })];
  const plugin: Plugin = {
    name: "notice-surface-transport", enforce: "pre",
    resolveId(source, importer) {
      if (!importer?.includes("/src/")) return null;
      if (source.endsWith("useAsyncPoll.ts") && importer.endsWith("/Dashboard.tsx")) return "\0notice-poll";
      if (connection?.error && source.endsWith("scheduler.ts") && importer.endsWith("/useStatusNotice.ts")) return "\0notice-scheduler";
      if (source.endsWith("api.ts")) return "\0notice-api";
      if (source.endsWith("TerminalPane.tsx")) return "\0notice-terminal";
      return null;
    },
    load(id) {
      if (id === "\0notice-scheduler") return `export const defaultScheduler={setTimeout:(callback,delay)=>setTimeout(callback,delay===5000?0:delay),clearTimeout};`;
      if (id === "\0notice-poll") return 'export function useAsyncPoll(task) {globalThis.__agentConsoleNoticePoll=task;}';
      if (id === "\0notice-terminal") return 'import {createElement} from "react"; export const TerminalPane = () => createElement("div", {className:"terminal-pane"});';
      if (id !== "\0notice-api") return null;
      // Start with real content, then fail a read. This retains pane and toolbar markup.
      return `export class SharedOutboxRequestError extends Error {}
        let sessionReads=0, shellReads=0;
        const responses = {
          listSessions: () => (${JSON.stringify(Boolean(connection))} ? !globalThis.__agentConsoleNoticeOutage : ++sessionReads === 1)
            ? {ok:true,sessions:${JSON.stringify(sessions)},machines:[{name:${JSON.stringify(machine)},ok:true,capabilities:{history:${Boolean(connection?.focusedConversation)}}}]}
            : {ok:false,error:${JSON.stringify(connection?.error ?? "Console server is unreachable")},sessions:[],machines:[{name:${JSON.stringify(machine)},ok:false}]},
          fetchLayoutOrder: () => ({reachable:false,order:[],revision:null}),
          usage: () => ({providers:[],reachable:false}),
          readSharedOutbox: () => ({revision:0,items:[],compose_holds:[]}),
          readEmergencyShell: (_machine, method) => {if(++shellReads === 2) throw new Error("Console server is unreachable"); return {owner:"alice",status:"running",incarnation:"shell-one"};},
        };
        ${apiNames.map(name => `export const ${name} = (...args) => Promise.resolve().then(() => responses.${name}?.(...args));`).join("\n")}`;
    },
  };
  const harness = createUiSsrHarness([plugin]);
  const { createRoot } = await import("react-dom/client");
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  try {
    if (surface === "shell") {
      const { ShellPage } = await harness.loadModule<typeof import("../../src/ShellPage.tsx")>("/src/ShellPage.tsx");
      await act(async () => root.render(createElement(ShellPage, { machines: [machine], onExit() {} })));
      await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Reconnect")!.click());
    } else {
      if (connection?.macTitleBar) {
        const { MacTitleBar } = await harness.loadModule<typeof import("../../src/MacTitleBar.tsx")>("/src/MacTitleBar.tsx");
        window.document.documentElement.dataset.macTitlebar = "true";
        container.insertAdjacentHTML("beforebegin", renderComponent(MacTitleBar, {}));
      }
      const { Dashboard } = await harness.loadModule<typeof import("../../src/Dashboard.tsx")>("/src/Dashboard.tsx");
      const renderDashboard = (active: boolean) => root.render(createElement(Dashboard, { active, machines: [machine], enabledMachines: [machine], machineColors: {},
        phoneFocusCounts: connection?.phoneFocusCounts, phoneSessionOpen: connection?.conversationUnavailable || connection?.focusedConversation ? "conversation" : "terminal", defaultAutoResume: false, terminalRenderMode: "realtime", terminalSelectedPaneRealtime: true, onDebug() {}, onUsage() {}, onSettings() {} }));
      await act(async () => renderDashboard(true));
      if (connection?.error) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
      const tick = { signal: new AbortController().signal, isCurrent: () => true };
      const poll = () => (globalThis as unknown as { __agentConsoleNoticePoll: (tick: object) => Promise<void> }).__agentConsoleNoticePoll(tick);
      if (connection?.focused) {
        const card = container.querySelector<HTMLElement>(".terminal-slot, .mobile-session-card");
        assert.ok(card, "focused notice fixture needs the loaded session card");
        const open = card.querySelector<HTMLElement>(".slot-open, .mobile-session-card-open-action");
        assert.ok(open, "focused notice fixture needs the explicit Open action");
        await act(async () => open.click());
        assert.ok(container.querySelector(".terminal-slot.is-focused"), "card opens the actual focused session");
      }
      if (connection?.focusedConversation) assert.ok(container.querySelector(".phone-conversation-pane"), "focused fixture includes the real conversation pane");
      connection?.inspectClear?.(window.document.body as unknown as HTMLElement, "initial");
      if (connection && (!connection.conversationUnavailable || connection.error)) (globalThis as unknown as { __agentConsoleNoticeOutage: boolean }).__agentConsoleNoticeOutage = true;
      await act(poll);
      await act(poll);
      connection?.inspect?.(window.document.body as unknown as HTMLElement, "unreachable");
      if (connection?.restore) {
        (globalThis as unknown as { __agentConsoleNoticeOutage: boolean }).__agentConsoleNoticeOutage = false;
        await act(poll);
        connection.inspect?.(window.document.body as unknown as HTMLElement, "restored");
      }
      if (connection?.inspectActive) {
        for (const active of [false, true]) {
          await act(async () => renderDashboard(active));
          connection.inspectActive(window.document.body as unknown as HTMLElement, active);
        }
      }
    }
    assert.ok(window.document.querySelector(".connection-notice"), `${surface} transport failure renders its notice`);
    const markup = window.document.body.innerHTML;
    if (connection?.inspectClear) {
      await act(async () => window.document.querySelector<HTMLElement>('[aria-label="Dismiss status notice"]')!.click());
      connection.inspectClear(window.document.body as unknown as HTMLElement, "dismissed");
    }
    return markup;
  } finally {
    await act(async () => root.unmount());
    await harness.close();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
  }
}
