import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import react from "@vitejs/plugin-react";
import { build } from "vite";
import { launchPage } from "./support/browserPage.ts";

test("Escape closes only the open browser picker before it closes the dialog", { timeout: 30_000 }, async t => {
  const page = await launchPage();
  t.after(() => page.close());
  if (!await page.evaluate("CSS.supports('appearance', 'base-select')")) {
    t.skip("Chrome lacks the customizable select picker");
    return;
  }

  const bundle = await build({
    root: fileURLToPath(new URL("..", import.meta.url)),
    resolve: { conditions: ["source"] },
    configFile: false,
    logLevel: "silent",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [react(), {
      name: "select-popup-fixture",
      resolveId(id) { if (id.endsWith("/select-popup-fixture.tsx")) return "\0select-popup-fixture.tsx"; },
      load(id) {
        if (id !== "\0select-popup-fixture.tsx") return;
        return `import React, { useState } from 'react';
          import { createRoot } from 'react-dom/client';
          import { AppSelect } from '/src/AppSelect.tsx';
          import { Modal } from '/src/Modal.tsx';
          function Example() {
            const [open, setOpen] = useState(true);
            return open && <Modal onClose={() => setOpen(false)} ariaLabel="Example dialog">
              <AppSelect aria-label="Example field" value="alpha" onChange={() => {}}>
                <option value="alpha">Alpha</option><option value="beta">Beta</option>
              </AppSelect>
            </Modal>;
          }
          createRoot(document.querySelector('#root')).render(<Example />);`;
      },
    }],
    build: { write: false, minify: false, target: "esnext", lib: { entry: "select-popup-fixture.tsx", name: "Fixture", formats: ["iife"] } },
  });
  const output = Array.isArray(bundle) ? bundle[0] : bundle;
  assert.ok(output && "output" in output);
  const code = output.output.find(item => item.type === "chunk")?.code;
  assert.ok(code);
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const temp = mkdtempSync(join(tmpdir(), "salon-select-popup-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const file = join(temp, "fixture.html");
  writeFileSync(file, `<!doctype html><html data-theme="dark"><meta charset="utf-8"><style>${css}</style>
    <div id="root"></div><script>${code.replaceAll("</script", "<\\/script")}</script>`);

  await page.setViewport(1280, 900, 1);
  await page.navigate(pathToFileURL(file).href);
  const frame = () => page.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  await frame();
  const point = await page.evaluate<{ x: number; y: number }>(`(() => {
    const rect = document.querySelector('select.app-select').getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  await page.click(point.x, point.y);
  await frame();
  assert.equal(await page.evaluate("document.querySelector('select').matches(':open')"), true, "the browser popup is open");

  await page.pressEscape();
  await frame();
  assert.equal(await page.evaluate("!!document.querySelector('[role=dialog]')"), true, "Escape leaves the dialog open");
  assert.equal(await page.evaluate("document.querySelector('select').matches(':open')"), false, "Escape closes the popup");
  assert.equal(await page.evaluate("document.activeElement.tagName"), "SELECT", "the select receives focus again");

  await page.pressEscape();
  await frame();
  assert.equal(await page.evaluate("!!document.querySelector('[role=dialog]')"), false, "a second Escape dismisses the dialog");
});
