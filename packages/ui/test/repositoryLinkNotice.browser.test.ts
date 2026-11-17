import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import react from "@vitejs/plugin-react";
import { build } from "vite";
import { hasHeadlessChrome, measureUiMarkup } from "./support/browserLayout.ts";

const message = "Repository link unavailable";

test("an unavailable repository destination is announced after lookup", async t => {
  assert.ok(hasHeadlessChrome(), "headless Chrome is required");
  const built = await build({
    configFile: false, logLevel: "silent", resolve: { conditions: ["source"] },
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [react(), {
      name: "repository-link-fixture",
      resolveId(id) {
        if (id.endsWith("repository-link-fixture")) return "\0repository-link-fixture";
        if (id === "./TerminalPane.tsx") return "\0repository-link-terminal";
      },
      load(id) {
        if (id === "\0repository-link-terminal") return "export const TerminalPane = () => null;";
        if (id !== "\0repository-link-fixture") return;
        return `
          import React from "react";
          import { createRoot } from "react-dom/client";
          import { Dashboard } from "/src/Dashboard.tsx";
          const machine = { name: "fixture", ok: true, active: true };
          const session = { id: "sample", machine: machine.name, status: "running", agent: "codex",
            title: "Example session", repo_name: "example", cwd: "/synthetic/example" };
          const lookup = Promise.withResolvers();
          window.fixture = { lookup, requestedPath: null, closed: false };
          window.fetch = async input => {
            const url = new URL(input, "http://fixture.invalid");
            switch (url.pathname) {
              case "/api/sessions":
                return Response.json({ ok: true, data: { sessions: [session], machines: [machine] } });
              case "/api/machines":
                return Response.json({ ok: true, data: { machines: [machine] } });
              case "/api/machine-preferences":
                return Response.json({ ok: true, data: { machines: [{ ...machine, enabled: true }] } });
              case "/api/machines/fixture/repo-url":
                window.fixture.requestedPath = url.searchParams.get("cwd");
                return lookup.promise;
              default:
                return Response.json({ ok: false }, { status: 404 });
            }
          };
          window.open = url => {
            if (url !== "about:blank") throw Error("Unexpected external navigation");
            return { close() { window.fixture.closed = true; } };
          };
          createRoot(document.querySelector("#root")).render(React.createElement(Dashboard, {
            active: true, machines: [machine.name], enabledMachines: [machine.name],
            machineColors: {}, defaultAutoResume: false, phoneSessionOpen: "terminal",
            sessionListDisplay: "conversation", terminalRenderMode: "realtime",
            terminalSelectedPaneRealtime: true, onDebug() {}, onUsage() {}, onSettings() {},
          }));
        `;
      },
    }],
    build: { write: false, target: "esnext", lib: { entry: "repository-link-fixture", name: "Fixture", formats: ["iife"] } },
  });
  const output = Array.isArray(built) ? built[0] : built;
  assert.ok(output && "output" in output);
  const script = output.output.find(item => item.type === "chunk");
  assert.ok(script);
  const css = output.output.flatMap(item => item.type === "asset" && item.fileName.endsWith(".css") ? [item.source] : []).join("\n");
  const markup = "<style>" + css + "</style><div id=\"root\"></div><script>" +
    script.code.replaceAll("</script", "<\\/script") + "</script>";
  const evidence = process.env.AGENT_CONSOLE_UI_SCREENSHOT_DIR;
  if (evidence) mkdirSync(evidence, { recursive: true });

  for (const [width, height] of [[384, 832], [760, 982], [761, 982], [1500, 982]] as const) {
    for (const focused of [false, true]) {
      const surface = focused ? "focused session" : "overview";
      await t.test(`${surface} at ${width} × ${height}`, () => {
        const measured = measureUiMarkup<{
          requestedPath: string; closed: boolean; prematureNotice: boolean;
          role: string | null; announcement: string | null; readable: boolean;
        }>(markup, width, `
          const waitFor = async predicate => {
            for (let attempt = 0; attempt < 60; attempt++) {
              const value = predicate();
              if (value) return value;
              await new Promise(resolve => setTimeout(resolve, 10));
            }
            return null;
          };
          const open = await waitFor(() => document.querySelector('button[aria-label="Open Example session"]'));
          if (!open) throw Error("Synthetic session did not load");
          if (${focused}) open.click();
          const card = await waitFor(() => document.querySelector(
            ${JSON.stringify(focused ? ".terminal-slot.is-focused" : (width <= 760 ? ".mobile-session-card" : ".terminal-slot"))}
          ));
          const badge = card?.querySelector('[aria-label="Open example repository"]');
          if (!badge) throw Error("Repository badge did not mount in the selected view");
          badge.click();
          const requestedPath = await waitFor(() => window.fixture.requestedPath);
          const findNotice = () => [...document.querySelectorAll(".connection-notice")]
            .find(node => node.textContent.includes(${JSON.stringify(message)}));
          const prematureNotice = Boolean(findNotice());
          window.fixture.lookup.resolve(Response.json({ ok: false }, { status: 404 }));
          const closed = Boolean(await waitFor(() => window.fixture.closed));
          const notice = await waitFor(findNotice);
          const announcement = notice?.querySelector(".connection-notice-message-full")
            ?? notice?.querySelector(".connection-notice-message");
          const visibleMessage = notice && [...notice.querySelectorAll(".connection-notice-message-compact, .connection-notice-message-full, .connection-notice-message")]
            .find(node => node.childElementCount === 0 && node.getBoundingClientRect().width > 1 && getComputedStyle(node).visibility === "visible");
          const result = {
            requestedPath, closed, prematureNotice,
            role: notice?.getAttribute("role") ?? null,
            announcement: announcement?.textContent ?? null,
            readable: Boolean(visibleMessage && visibleMessage.scrollWidth <= visibleMessage.clientWidth + 1),
          };
        `, false, height, evidence ? [`--screenshot=${join(evidence, `repository-link-${focused ? "focused" : "overview"}-${width}.png`)}`] : []);
        assert.equal(measured.requestedPath, "/synthetic/example");
        assert.equal(measured.closed, true, "the unused blank tab closes after lookup");
        assert.equal(measured.prematureNotice, false, "there is no failure before lookup completes");
        assert.equal(measured.announcement, message, "the failed lookup produces an explicit result");
        assert.equal(measured.readable, true, "the full result fits in the active view");
        assert.equal(measured.role, "alert", "the failure is announced");
      });
    }
  }
});
