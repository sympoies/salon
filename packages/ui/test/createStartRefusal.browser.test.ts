import { strict as assert } from "node:assert";
import { join } from "node:path";
import { test } from "node:test";
import react from "@vitejs/plugin-react";
import { build } from "vite";
import { hasHeadlessChrome, measureUiMarkup } from "./support/browserLayout.ts";

const message = "The provider requires startup configuration or sign-in before retrying.";

test("Dashboard shows a definite start refusal and allows a new session", async t => {
  assert.ok(hasHeadlessChrome(), "headless Chrome is required");
  const built = await build({
    configFile: false, logLevel: "silent", resolve: { conditions: ["source"] },
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [react(), {
      name: "create-start-refusal-fixture",
      resolveId(id) {
        if (id.endsWith("create-start-refusal-fixture")) return "\0create-start-refusal-fixture";
      },
      load(id) {
        if (id !== "\0create-start-refusal-fixture") return;
        return `
          import React from "react";
          import { createRoot } from "react-dom/client";
          import { Dashboard } from "/src/Dashboard.tsx";
          const machine = { name: "fixture", ok: true, active: true };
          window.fetch = async (input, init) => {
            const path = new URL(input, "http://fixture.invalid").pathname;
            if (path === "/api/sessions/fixture" && init?.method === "POST") {
              return Response.json({ ok: false, error: {
                code: "start-failed", message: "session creation failed",
                details: { code: "start-failed", reason: "startup-prompt-required", message: ${JSON.stringify(message)} },
              } }, { status: 500 });
            }
            if (path === "/api/sessions") {
              return Response.json({ ok: true, data: { sessions: [], machines: [machine] } });
            }
            return Response.json({ ok: false }, { status: 404 });
          };
          createRoot(document.querySelector("#root")).render(React.createElement(Dashboard, {
            active: true, machines: [machine.name], enabledMachines: [machine.name], machineColors: {},
            onDebug() {}, onUsage() {}, onSettings() {},
          }));
        `;
      },
    }],
    build: { write: false, lib: { entry: "create-start-refusal-fixture", name: "Fixture", formats: ["iife"] } },
  });
  const output = Array.isArray(built) ? built[0] : built;
  assert.ok(output && "output" in output);
  const script = output.output.find(item => item.type === "chunk");
  assert.ok(script);
  const css = output.output.flatMap(item => item.type === "asset" && item.fileName.endsWith(".css") ? [item.source] : []).join("\n");
  const markup = "<style>" + css + "</style><div id=\"root\"></div><script>" +
    script.code.replaceAll("</script", "<\\/script") + "</script>";
  const capture = process.env.AGENT_CONSOLE_UI_SCREENSHOT_DIR;

  for (const [width, height] of [[390, 832], [760, 900], [761, 900], [1280, 900]] as const) {
    await t.test(`${width} × ${height}`, () => {
      const measured = measureUiMarkup<{
        errorText: string; unknown: boolean; newDisabled: boolean; stopped: boolean; readable: boolean;
      }>(markup, width, `
        const waitFor = async find => {
          for (let attempt = 0; attempt < 60; attempt++) {
            const value = find();
            if (value) return value;
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          throw Error("Create fixture did not reach the expected state");
        };
        const newButton = await waitFor(() => document.querySelector("button.dashboard-new-session"));
        newButton.click();
        const create = await waitFor(() => {
          const button = document.querySelector(".modal-actions button.primary");
          return button && !button.disabled && button;
        });
        create.click();
        const error = await waitFor(() => document.querySelector(".modal .err"));
        if (${Boolean(capture)}) {
          const style = parent.document.createElement("style");
          style.textContent = "#measurement { display: none; } body { margin: 0; }";
          parent.document.head.append(style);
        }
        const rect = error.getBoundingClientRect();
        const result = {
          errorText: error.textContent,
          unknown: Boolean(document.querySelector(".create-prompt-recovery")),
          newDisabled: newButton.disabled,
          stopped: document.body.innerText.includes("Session stopped"),
          readable: rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth
            && rect.top >= 0 && rect.bottom <= innerHeight && error.scrollWidth <= error.clientWidth + 1,
        };
      `, false, height, capture ? [
        `--window-size=${Math.max(500, width)},${height}`,
        `--screenshot=${join(capture, `start-refusal-${width}.png`)}`,
      ] : []);
      assert.deepEqual({ unknown: measured.unknown, newDisabled: measured.newDisabled, stopped: measured.stopped },
        { unknown: false, newDisabled: false, stopped: false });
      assert.ok(measured.errorText.includes(message), "the daemon message is visible");
      assert.match(measured.errorText, /Sign in to the provider on the selected machine, then try again\./);
      assert.equal(measured.readable, true, "the refusal fits without horizontal clipping");
    });
  }
});
