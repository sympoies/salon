import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { hasHeadlessChrome } from "./support/browserLayout.ts";

const MACHINES = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf"];

// Real mouse drags in headless Chrome: the preview moves the dragged row's DOM node, which
// releases pointer capture in a browser, so the drop must still commit in both directions.
test("repeated mouse drags on a 7-row Machines list commit at the slot under the pointer, down and up", async t => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const fixture = `
    import React, { useState } from "react";
    import { createRoot } from "react-dom/client";
    import { MachineOrderList } from "/src/MachineOrderList.tsx";
    window.reorders = [];
    function Harness() {
      const [machines, setMachines] = useState(${JSON.stringify(MACHINES)});
      return React.createElement(MachineOrderList, {
        machines,
        onReorder: order => { window.reorders.push([...order]); setMachines(order); },
        renderActions: name => React.createElement("span", null, "actions " + name),
      });
    }
    createRoot(document.querySelector("#root")).render(React.createElement(Harness));
  `;
  const bundled = await build({
    configFile: false, logLevel: "silent", define: { "process.env.NODE_ENV": JSON.stringify("production") }, plugins: [react(), {
      name: "machine-drag-fixture",
      resolveId(id) { if (id.endsWith("machine-drag-fixture")) return "\0machine-drag-fixture"; },
      load(id) { if (id === "\0machine-drag-fixture") return fixture; },
    }],
    build: { write: false, minify: false, lib: { entry: "machine-drag-fixture", name: "MachineDragFixture", formats: ["iife"] } },
  });
  const output = Array.isArray(bundled) ? bundled[0] : bundled;
  assert.ok(output && "output" in output);
  const code = output.output.filter(item => item.type === "chunk").map(item => item.code).join("\n");
  const css = readFileSync(join(process.cwd(), "src", "styles.css"), "utf8");
  const temp = mkdtempSync(join(tmpdir(), "agent-console-machine-drag-"));
  const browser = spawn(process.env.CHROME_BIN ?? "google-chrome", [
    "--headless", "--disable-gpu", "--no-sandbox", "--remote-debugging-port=0", `--user-data-dir=${temp}`, "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let socket: WebSocket | undefined;
  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      let stderr = "";
      const timeout = setTimeout(() => reject(new Error("Chrome debugging endpoint timed out")), 10_000);
      browser.stderr.on("data", data => {
        stderr += data.toString();
        const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) { clearTimeout(timeout); resolve(match[1]!); }
      });
      browser.once("error", error => { clearTimeout(timeout); reject(error); });
      browser.once("exit", () => { clearTimeout(timeout); reject(new Error("Chrome exited before debugging was ready")); });
    });
    const pages = await (await fetch(new URL("/json/list", endpoint.replace("ws:", "http:")))).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
    const page = pages.find(item => item.type === "page"); assert.ok(page);
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { socket!.addEventListener("open", () => resolve(), { once: true }); socket!.addEventListener("error", reject, { once: true }); });
    let id = 0;
    const pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void }>();
    socket.addEventListener("message", event => {
      const reply = JSON.parse(String(event.data)), waiter = pending.get(reply.id);
      if (waiter) { pending.delete(reply.id); reply.error ? waiter.reject(new Error(JSON.stringify(reply.error))) : waiter.resolve(reply.result); }
    });
    const send = (method: string, params: object = {}) => new Promise<any>((resolve, reject) => {
      const request = ++id; pending.set(request, { resolve, reject }); socket!.send(JSON.stringify({ id: request, method, params }));
    });
    const evaluate = async (expression: string) => {
      const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      assert.equal(result.exceptionDetails, undefined, "browser fixture executes successfully");
      return result.result.value;
    };
    await send("Page.enable");
    await send("Runtime.enable");
    const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${code.replaceAll("</script", "<\\/script")}</script>`;
    const { frameTree } = await send("Page.getFrameTree");
    await send("Page.setDocumentContent", { frameId: frameTree.frame.id, html });
    for (let attempt = 0; attempt < 100 && !(await evaluate(`document.querySelectorAll("[data-reorder-key]").length === ${MACHINES.length}`)); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    const names = () => evaluate(`[...document.querySelectorAll("[data-reorder-key]")].map(row => row.dataset.reorderKey)`) as Promise<string[]>;
    // Row geometry comes from the page, so the test does not depend on font metrics.
    const geometry = () => evaluate(`[...document.querySelectorAll("[data-reorder-key]")].map(row => {
      const box = row.getBoundingClientRect(), grip = row.querySelector("[data-reorder-handle]").getBoundingClientRect();
      return { centre: (box.top + box.bottom) / 2, gripX: (grip.left + grip.right) / 2, driftX: box.left + box.width * 0.6 };
    })`) as Promise<Array<{ centre: number; gripX: number; driftX: number }>>;
    const mouse = (type: string, x: number, y: number, buttons: number) =>
      send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" && buttons === 0 ? "none" : "left", buttons, clickCount: type === "mouseMoved" ? 0 : 1 });
    const drag = async (from: number, to: number) => {
      const rows = await geometry();
      const startX = rows[from]!.gripX, endX = rows[to]!.driftX, start = rows[from]!.centre, end = rows[to]!.centre;
      await mouse("mouseMoved", startX, start, 0);
      await mouse("mousePressed", startX, start, 1);
      // A hand drifts sideways while dragging, so the release is not over the small handle.
      const steps = 12;
      for (let step = 1; step <= steps; step++) await mouse("mouseMoved", startX + (endX - startX) * step / steps, start + (end - start) * step / steps, 1);
      await mouse("mouseReleased", endX, end, 0);
      await new Promise(resolve => setTimeout(resolve, 50));
    };

    // Downward drags first (they fail on the unfixed list), then upward controls.
    const sequence: Array<[number, number]> = [[0, 1], [1, 2], [0, 6], [0, 2], [1, 3], [0, 5], [5, 0], [6, 2], [3, 1], [2, 0]];
    let expected = [...MACHINES];
    for (const [from, to] of sequence) {
      const moved = expected[from]!;
      expected = expected.filter(name => name !== moved);
      expected.splice(to, 0, moved);
      await drag(from, to);
      assert.deepEqual(await names(), expected, `drag ${from}→${to} lands on the slot under the pointer`);
    }
    const reorders = await evaluate("window.reorders") as string[][];
    assert.equal(reorders.length, sequence.length, "every drag commits exactly once");
  } finally {
    socket?.close();
    browser.kill();
    await new Promise(resolve => { if (browser.exitCode !== null || browser.signalCode !== null) resolve(null); else browser.once("exit", resolve); });
    rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
