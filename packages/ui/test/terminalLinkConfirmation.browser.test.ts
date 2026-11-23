import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import react from "@vitejs/plugin-react";
import { build } from "vite";
import { hasHeadlessChrome } from "./support/browserLayout.ts";
import { launchPage } from "./support/browserPage.ts";

const url = "https://example.test/docs/terminal-link";
const fixture = `
  import React from "react";
  import { createRoot } from "react-dom/client";
  import { TerminalPane } from "/src/TerminalPane.tsx";

  window.nativeConfirmations = [];
  window.opened = [];
  window.confirm = message => { window.nativeConfirmations.push(message); return false; };
  window.open = (...args) => { window.opened.push(args); return null; };
  createRoot(document.querySelector("#root")).render(
    React.createElement(TerminalPane, { machine: "fixture", id: "terminal", agent: "shell", showKeyBar: false })
  );
`;
const adapter = `
  export const BASE_TERMINAL_FONT_SIZE = 14;
  export function createTerminalInstance(host, deps) {
    window.showTerminalLinks = () => deps.setTerminalTouchMenu({
      key: deps.terminalInstanceKey, x: 8, y: 8, width: 290,
      hasSelection: false, linkUrl: null, links: [{ url: ${JSON.stringify(url)}, label: "Documentation" }],
    });
    return () => {};
  }
`;

test("terminal link picker discloses the exact target before opening it", async t => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const dir = mkdtempSync(join(tmpdir(), "terminal-confirmation-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bundle = await build({
    root: new URL("..", import.meta.url).pathname,
    configFile: false,
    logLevel: "silent",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [react(), {
      name: "terminal-confirmation-fixture",
      enforce: "pre",
      resolveId(id, importer) {
        if (id.endsWith("/terminal-confirmation") || id === "terminal-confirmation") return "\0terminal-confirmation";
        if (id === "./terminalInstance.ts" && importer?.endsWith("/src/TerminalPane.tsx")) return "\0terminal-adapter";
      },
      load(id) {
        if (id === "\0terminal-confirmation") return fixture;
        if (id === "\0terminal-adapter") return adapter;
      },
    }],
    build: { write: false, lib: { entry: "terminal-confirmation", name: "TerminalFixture", formats: ["iife"] } },
  });
  const output = Array.isArray(bundle) ? bundle[0] : bundle;
  assert.ok(output && "output" in output);
  const code = output.output.filter(item => item.type === "chunk").map(item => item.code).join("\n");
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const file = join(dir, "fixture.html");
  writeFileSync(file, `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>${css} .terminal-pane { height: 360px; }</style><div id="root"></div><script>${code}</script>`);

  const page = await launchPage();
  t.after(() => page.close());
  await page.addInitScript("window.addEventListener('error', event => { window.fixtureError = event.message; });");
  await page.navigate(pathToFileURL(file).href);
  const wait = (expression: string, label: string) => page.evaluate(`(async () => {
    const deadline = performance.now() + 5000;
    while (!(${expression})) {
      if (window.fixtureError) throw Error(window.fixtureError);
      if (performance.now() >= deadline) throw Error(${JSON.stringify(label)});
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  })()`);
  const dialog = `document.querySelector('[role="dialog"][aria-label="Open terminal link"]')`;
  const click = async (label: string) => {
    const point = await page.evaluate<[number, number]>(`(() => {
      const button = [...document.querySelectorAll("button")].find(el => el.textContent.trim() === ${JSON.stringify(label)});
      if (!button) throw Error("Confirmation fixture button is missing");
      const { x, y, width, height } = button.getBoundingClientRect();
      return [x + width / 2, y + height / 2];
    })()`);
    await page.click(...point);
  };
  const openConfirmation = async () => {
    await wait("window.showTerminalLinks", "mount terminal");
    await page.evaluate("window.showTerminalLinks()");
    await wait("document.querySelector('.terminal-touch-menu')", "show terminal link menu");
    await click("Links");
    await wait("document.querySelector('.terminal-link-picker li button')", "show terminal link picker");
    await page.evaluate("document.querySelector('.terminal-link-picker li button').click()");
    assert.deepEqual(await page.evaluate("window.nativeConfirmations"), [], "terminal link uses an in-app confirmation");
    await wait(dialog, "show open terminal link dialog");
    assert.ok((await page.evaluate<string>(`${dialog}.textContent`)).includes(url));
    assert.deepEqual(await page.evaluate("window.opened"), []);
  };

  await openConfirmation();
  await wait('document.activeElement.textContent === "Cancel"', "focus Cancel initially");
  await page.evaluate('document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }))');
  assert.equal(await page.evaluate("document.activeElement.textContent.trim()"), "Open link");
  await page.evaluate('document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }))');
  assert.equal(await page.evaluate("document.activeElement.textContent.trim()"), "Cancel");
  await click("Cancel");
  await wait(`!${dialog}`, "Cancel closes the confirmation");
  await openConfirmation();
  await page.evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  await wait(`!${dialog}`, "Escape closes the confirmation");

  await page.evaluate("window.__TAURI__ = {}");
  await openConfirmation();
  await wait("history.state?.agentConsoleBack === 'confirmation'", "push Android Back entry");
  await page.evaluate("history.back()");
  await wait(`!${dialog}`, "Back closes the confirmation");
  await page.evaluate("delete window.__TAURI__");

  await openConfirmation();
  await click("Open link");
  await wait("window.opened.length === 1", "confirm opens the disclosed target");
  assert.deepEqual(await page.evaluate("window.opened"), [[url, "_blank", "noopener,noreferrer"]]);
});
