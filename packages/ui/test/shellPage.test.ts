import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import type { Plugin } from "vite";
import { assertNoElement } from "./support/domAssert.ts";
import { createUiSsrHarness } from "./support/ssr.ts";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
const stopped = { schema_version: "agent-session.shell.v1", owner: "alice", status: "stopped", incarnation: null, tmux_name: "ac-shell-alice" };
const running = { ...stopped, status: "running", incarnation: "shell-one" };

test("Shell page reads on entry, opens once, serializes reconnect and ends only explicitly", async () => {
  const calls: unknown[][] = [];
  let pending: ReturnType<typeof deferred<unknown>> | null = null;
  const mock = async (...args: unknown[]) => { calls.push(args); return pending ? pending.promise : args[1] === "DELETE" ? stopped : args[1] === "POST" ? running : stopped; };
  Object.assign(globalThis, { __shellPageRead: mock });
  const plugin: Plugin = { name:"shell-page-mock", enforce:"pre", resolveId(source, importer) {
    if (!importer?.endsWith("/ShellPage.tsx")) return null;
    return source === "./api.ts" ? "\0shell-api" : source === "./TerminalPane.tsx" ? "\0shell-terminal" : null;
  }, load(id) {
    if (id === "\0shell-api") return "export const readEmergencyShell = (...args) => globalThis.__shellPageRead(...args);";
    if (id === "\0shell-terminal") return 'import {createElement} from "react"; export const TerminalPane = (props) => { globalThis.__shellPageStatus = props.onStatusChange; return createElement("div", {"data-shell-terminal": props.machine + "/" + props.id}); };';
    return null;
  } };
  const harness = createUiSsrHarness([plugin]);
  const { ShellPage } = await harness.loadModule<{ ShellPage: ComponentType<{ machines: string[]; onExit():void }> }>("/src/ShellPage.tsx");
  const window = new Window({url:"http://localhost"});
  const keys = ["window","document","HTMLElement","Element","IS_REACT_ACT_ENVIRONMENT"];
  const previous = keys.map(key => Object.getOwnPropertyDescriptor(globalThis,key));
  Object.assign(globalThis, {window, document:window.document, HTMLElement:window.HTMLElement, Element:window.Element, IS_REACT_ACT_ENVIRONMENT:true});
  window.confirm = () => true;
  const container = window.document.createElement("div"); window.document.body.append(container); const root = createRoot(container);
  const button = (text: string) => [...container.querySelectorAll("button")].find(el => el.textContent === text)!;
  const click = (text: string) => button(text).dispatchEvent(new window.MouseEvent("click",{bubbles:true}));
  try {
    await act(async () => root.render(createElement(ShellPage,{machines:["a","b"],onExit() {}})));
    assert.deepEqual(calls, [["a"]]);
    pending = deferred();
    await act(async () => { click("Open Shell"); click("Open Shell"); });
    assert.equal(calls.filter(c => c[1] === "POST").length, 1);
    await act(async () => { pending!.resolve(running); }); pending = null;
    assert.ok(container.querySelector("[data-shell-terminal='a/shell-one']"));
    pending = deferred();
    await act(async () => { (globalThis as any).__shellPageStatus("closed"); });
    assert.equal(calls.at(-1)?.[1],undefined);
    await act(async () => { pending!.resolve(stopped); }); pending = null;
    assertNoElement(container,"[data-shell-terminal]");
    assert.equal(button("Open Shell").disabled,false);
    await act(async () => click("Open Shell"));
    pending = deferred();
    await act(async () => click("Reconnect"));
    assert.equal(button("End Shell").disabled,true);
    await act(async () => click("End Shell"));
    assert.equal(calls.filter(c => c[1] === "DELETE").length,0);
    await act(async () => { pending!.resolve(running); }); pending = null;
    await act(async () => click("End Shell"));
    assert.deepEqual(calls.at(-1),["a","DELETE","shell-one"]);
    assertNoElement(container,"[data-shell-terminal]");
    const before = calls.length;
    await act(async () => root.unmount());
    assert.equal(calls.length,before);
  } finally {
    await harness.close();
    keys.forEach((key,index) => previous[index] ? Object.defineProperty(globalThis,key,previous[index]!) : Reflect.deleteProperty(globalThis,key));
    Reflect.deleteProperty(globalThis,"__shellPageRead"); Reflect.deleteProperty(globalThis,"__shellPageStatus"); await window.happyDOM.close();
  }
});
