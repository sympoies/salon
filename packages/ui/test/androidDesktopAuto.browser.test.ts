import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import react from "@vitejs/plugin-react";
import { build } from "vite";
import { launchPage, type Page } from "./support/browserPage.ts";
import { makeSession } from "./support/fixtures.ts";

const sessions = Array.from({ length: 6 }, (_, index) => makeSession({
  id: `tile-${index + 1}`,
  session_incarnation: `tile-launch-${index + 1}`,
  machine: "fixture",
  title: `Session ${index + 1}`,
  cwd: "/workspace/greenhouse",
  repo_name: "greenhouse",
  model: "gpt-5.4",
  reasoning_effort: "medium",
  turn_state: {
    schema_version: "agent-session.turn-state.v1",
    phase: "waiting",
    phase_changed_at: "2026-07-06T00:00:00Z",
    revision: 1,
    source: { kind: "provider_hook", provider: "codex", confidence: "authoritative" },
  },
  provider_resume: { provider: "codex", session_id: `thread-${index + 1}` },
}));

async function dashboardFixture(): Promise<string> {
  const built = await build({
    configFile: false, logLevel: "silent", resolve: { conditions: ["source"] },
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [react(), {
      name: "android-desktop-auto-fixture",
      enforce: "pre",
      resolveId(id) {
        if (id.endsWith("android-desktop-auto-fixture")) return "\0android-desktop-auto";
        if (id === "@tauri-apps/plugin-http") return "\0android-desktop-http";
        if (id === "./resourceEvents.ts") return "\0android-desktop-events";
      },
      load(id) {
        if (id === "\0android-desktop-http") return "export const fetch = (...args) => window.fetch(...args);";
        if (id === "\0android-desktop-events") return `export const RESOURCE_RECONCILE_MS = 30000;
          export const resourceEvents = { subscribe(_key, _change, health) { health(false); return () => {}; } };`;
        if (id !== "\0android-desktop-auto") return;
        return `
          import React from "react";
          import { createRoot } from "react-dom/client";
          import { Dashboard } from "/src/Dashboard.tsx";
          import { loadAndroidLayout } from "/src/androidLayout.ts";
          import "/src/styles.css";
          const sessions = ${JSON.stringify(sessions)};
          const machine = { name: "fixture", ok: true, active: true, capabilities: { history: true } };
          const history = sessions.map(session => ({
            id: session.id, machine: machine.name, provider: "codex",
            provider_session_id: session.provider_resume.session_id,
            title: session.title, cwd: session.cwd,
            created_at: session.created_at, updated_at: session.updated_at, resumable: true,
          }));
          window.fetch = async input => {
            const { pathname } = new URL(input, "https://fixture.invalid");
            const ok = data => Response.json({ ok: true, data });
            switch (pathname) {
              case "/api/sessions": return ok({ sessions, machines: [machine] });
              case "/api/machines": return ok({ machines: [machine] });
              case "/api/machine-preferences": return ok({ machines: [{ ...machine, enabled: true }] });
              case "/api/history/sessions": return ok({ sessions: history });
            }
            if (pathname.startsWith("/api/history/sessions/") && pathname.endsWith("/messages")) {
              return ok({ messages: [{ id: "response", role: "assistant", text: "The seedlings are ready." }] });
            }
            return Response.json({ ok: false }, { status: 404 });
          };
          createRoot(document.querySelector("#root")).render(React.createElement(Dashboard, {
            active: true, machines: [machine.name], enabledMachines: [machine.name],
            machineColors: {}, androidLayout: loadAndroidLayout(), phoneSessionOpen: "conversation",
            defaultAutoResume: false, terminalRenderMode: "realtime", terminalSelectedPaneRealtime: true,
            onDebug() {}, onUsage() {}, onSettings() {},
          }));
        `;
      },
    }],
    build: { write: false, target: "esnext", lib: { entry: "android-desktop-auto-fixture", name: "Fixture", formats: ["iife"] } },
  });
  const output = Array.isArray(built) ? built[0] : built;
  assert.ok(output && "output" in output);
  const script = output.output.find(item => item.type === "chunk");
  assert.ok(script);
  const css = output.output.flatMap(item => item.type === "asset" && item.fileName.endsWith(".css") ? [item.source] : []).join("\n");
  return `<!doctype html><html lang="en"><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style>
    <div id="root"></div><script>${script.code.replaceAll("</script", "<\\/script")}</script></html>`;
}

async function waitFor(page: Page, condition: string): Promise<void> {
  await page.evaluate(`(async () => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (${condition}) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw Error("Dashboard did not reach: " + ${JSON.stringify(condition)});
  })()`);
}

async function click(page: Page, selector: string): Promise<void> {
  const { x, y } = await page.evaluate<{ x: number; y: number }>(`(() => {
    const button = document.querySelector(${JSON.stringify(selector)});
    if (!button) throw Error("Button missing: " + ${JSON.stringify(selector)});
    button.scrollIntoView({ block: "nearest" });
    const rect = button.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`);
  await page.click(x, y);
}

const picker = ".layout-picker-trigger";
const tile = ".session-workspace.desktop > .terminal-slot";
const auto = ".layout-picker-option:first-child";
const autoGrid = `document.querySelectorAll('${tile} .history-message').length === 6`;
const autoSelected = `document.querySelector('${picker}')?.getAttribute('aria-label')?.includes('currently Auto,')`;
const viewportHeight = 800;

interface Grid {
  width: number;
  columns: number;
  noOverflow: boolean;
  tiles: {
    badgeAndActionsFit: boolean;
    modelFits: boolean;
    statusFits: boolean;
    composerWidth: number;
    composerReachable: boolean;
  }[];
}

async function measureGrid(page: Page): Promise<Grid> {
  return page.evaluate<Grid>(`(() => {
    const root = document.documentElement;
    const grid = document.querySelector(".session-workspace.desktop");
    const slots = [...grid.querySelectorAll(":scope > .terminal-slot")];
    const box = node => node.getBoundingClientRect();
    const inside = (outer, inner) => inner.width > 0 && inner.left >= outer.left - 1 && inner.right <= outer.right + 1;
    const textFits = element => element.clientWidth > 0 && element.scrollWidth <= element.clientWidth + 1;
    const tiles = slots.map(slot => {
      const row = slot.querySelector(".slot-session-card-row-one");
      const badge = box(row.querySelector(".repo-badge"));
      const actions = [...row.querySelectorAll(".session-command-copy-button, :scope > button")].map(box);
      const model = slot.querySelector(".session-model-name");
      const effort = slot.querySelector(".session-model-effort");
      const status = slot.querySelector(".session-activity-text");
      const composer = slot.querySelector(".conversation-composer textarea");
      composer.scrollIntoView({ block: "nearest" });
      const reply = box(composer);
      const visible = box(grid);
      const hit = document.elementFromPoint(reply.left + reply.width / 2, reply.top + reply.height / 2);
      return {
        badgeAndActionsFit: actions.length === 3 && inside(box(row), badge)
          && actions.every((action, index) => inside(box(row), action)
            && action.left >= (actions[index - 1]?.right ?? badge.right) - 1),
        modelFits: textFits(model) && inside(box(model.parentElement), box(effort)),
        statusFits: status.textContent === "5m" && textFits(status) && inside(box(status.parentElement), box(status)),
        composerWidth: reply.width,
        composerReachable: reply.top >= visible.top - 1 && reply.bottom <= visible.bottom + 1 && hit === composer,
      };
    });
    const result = {
      width: innerWidth,
      columns: new Set(slots.map(slot => box(slot).left)).size,
      noOverflow: [root, grid, ...slots].every(node => node.scrollWidth <= node.clientWidth + 1),
      tiles,
    };
    grid.scrollTop = 0;
    return result;
  })()`);
}

test("Android Desktop Auto keeps six conversation tiles usable through width changes", async t => {
  const temp = mkdtempSync("/tmp/salon-desktop-auto-");
  const fixture = pathToFileURL(join(temp, "fixture.html")).href;
  const evidence = process.env.AGENT_CONSOLE_UI_SCREENSHOT_DIR;
  let page: Page | undefined;
  try {
    writeFileSync(new URL(fixture), await dashboardFixture());
    page = await launchPage();
    const browser = page;
    await browser.setEnvironment("UTC", "en-US");
    await browser.addInitScript(`
      window.__TAURI__ = {};
      Object.defineProperty(navigator, "userAgent", { value: "Synthetic Android WebView" });
      localStorage.setItem("ac.androidLayoutChoice", "desktop");
      Date.now = () => Date.parse("2026-07-06T00:05:00Z");
    `);
    await browser.setViewport(600, viewportHeight, 1, true);
    await browser.navigate(fixture);
    await waitFor(browser, `document.querySelector('${picker}')?.getBoundingClientRect().width > 0`);
    await click(browser, picker);
    await waitFor(browser, `document.querySelector('${auto}')?.getAttribute('aria-checked') === 'false'`);
    await click(browser, auto);
    await waitFor(browser, autoGrid);

    await t.test("320, 384, and 600 CSS px and both sides of the column boundary", async t => {
      for (const [width, columns] of [[600, 2], [384, 1], [600, 2], [320, 1], [576, 1], [577, 2]] as const) {
        await t.test(`${width}px (${columns} column${columns === 1 ? "" : "s"})`, async () => {
          await browser.setViewport(width, viewportHeight, 1, true);
          await waitFor(browser, `innerWidth === ${width} && ${autoSelected}
            && document.querySelector('${picker}').getBoundingClientRect().width > 0`);
          await browser.evaluate("document.fonts.ready.then(() => true)");
          if (evidence) {
            mkdirSync(evidence, { recursive: true });
            writeFileSync(join(evidence, `desktop-auto-${width}.png`), await browser.screenshot());
          }
          const grid = await measureGrid(browser);
          assert.equal(grid.width, width, "viewport uses CSS pixels");
          assert.equal(grid.tiles.length, 6, "all sessions remain on the Auto page");
          assert.equal(grid.columns, columns, JSON.stringify(grid));
          assert.equal(grid.noOverflow, true, "grid and tiles fit the viewport horizontally");
          for (const [index, measured] of grid.tiles.entries()) {
            const detail = `session ${index + 1} at ${width}px: ${JSON.stringify(measured)}`;
            assert.ok(measured.badgeAndActionsFit, detail);
            assert.ok(measured.modelFits && measured.statusFits, detail);
            assert.ok(measured.composerWidth >= 120 && measured.composerReachable, detail);
          }
        });
      }
    });

    await t.test("each manual pane count persists after reload at phone width", async () => {
      await browser.setViewport(384, viewportHeight, 1, true);
      for (const count of [1, 2, 3, 4, 5, 6]) {
        const option = `.layout-picker-option:nth-child(${count + 1})`;
        const current = `document.querySelector('${picker}')?.getAttribute('aria-label') === "Choose layout, currently ${count} pane${count === 1 ? "" : "s"}"`;
        const countMatches = `document.querySelectorAll('${tile}').length === ${count}`;
        await click(browser, picker);
        await click(browser, option);
        await waitFor(browser, `${current} && ${countMatches}`);
        await browser.navigate(fixture);
        await waitFor(browser, `${current} && ${countMatches}`);
        await click(browser, picker);
        assert.equal(await browser.evaluate(`document.querySelector('${option}')?.getAttribute('aria-checked')`), "true");
        await click(browser, picker);
      }
    });

    await t.test("Android Back returns from full-screen Conversation with Auto selected", async () => {
      await click(browser, picker);
      await click(browser, auto);
      await waitFor(browser, autoGrid);
      await click(browser, 'button[aria-label="Open Session 1"]');
      await waitFor(browser, "document.querySelector('.phone-conversation-pane .history-message')");
      assert.deepEqual(await browser.evaluate(`(() => {
        const focused = document.querySelector(".session-workspace.mobile > .terminal-slot.is-focused");
        const box = focused.getBoundingClientRect();
        return [box.left, box.top, box.right, box.bottom, document.querySelectorAll("${tile}").length];
      })()`), [0, 0, 384, viewportHeight, 0]);
      await waitFor(browser, "history.state?.agentConsoleBack === 'focused-session'");
      await browser.evaluate("history.back()");
      await waitFor(browser, `${autoGrid} && ${autoSelected} && !document.querySelector('.phone-conversation-pane')`);
    });
  } finally {
    await page?.close();
    rmSync(temp, { recursive: true, force: true });
  }
});
