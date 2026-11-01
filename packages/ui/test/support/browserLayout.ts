import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPhoneWidth } from "../../src/phoneTier.ts";

const chrome = process.env.CHROME_BIN ?? "google-chrome";
export function hasHeadlessChrome(): boolean {
  const probe = spawnSync(chrome, ["--version"], { encoding: "utf8" });
  return !probe.error && probe.status === 0;
}

/** Publishes the tier the way the app does (phoneTier.ts), for pages that load styles.css directly. */
export const phoneTierScript = `<script>document.documentElement.dataset.phoneTier=String((${isPhoneWidth.toString()})(innerWidth,matchMedia('(pointer: coarse)').matches,false));</script>`;

/** Chrome clamps its window width; an iframe gives phone tests the exact viewport. */
export function measureUiMarkup<T>(markup: string, width: number, script: string, reducedMotion = false, height = 800, chromeArgs: readonly string[] = [], hideScrollbars = true): T {
  const css = readFileSync(new URL("../../src/styles.css", import.meta.url), "utf8");
  const temp = mkdtempSync(join(tmpdir(), "agent-console-layout-"));
  try {
    const path = join(temp, "layout.html");
    const frameHtml = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style>
      <style>:root{--ac-safe-area-top:24px}</style>${phoneTierScript}${markup}<script>
        try {${script};result.viewportWidth=innerWidth;parent.document.querySelector('#measurement').textContent=JSON.stringify(result);}
        catch(error){parent.document.querySelector('#measurement').textContent=JSON.stringify({error:String(error)});}
      </script>`;
    writeFileSync(path, `<!doctype html><pre id="measurement"></pre><script>
      const frame=document.createElement('iframe');frame.style.cssText='display:block;border:0;width:${width}px;height:${height}px';
      frame.srcdoc=${JSON.stringify(frameHtml).replaceAll("<", "\\u003c")};document.body.append(frame);
      </script>`);
    const result = spawnSync(chrome, ["--headless", "--disable-gpu", "--no-sandbox", ...(hideScrollbars ? ["--hide-scrollbars"] : []), "--window-size=1400,1100",
      "--virtual-time-budget=3000", ...(reducedMotion ? ["--force-prefers-reduced-motion=reduce"] : []), ...chromeArgs, "--dump-dom", `file://${path}`],
    { encoding: "utf8", timeout: 15_000 });
    assert.equal(result.status, 0, `Chrome failed: ${result.stderr}`);
    const json = result.stdout.match(/<pre id="measurement">(.+?)<\/pre>/s)?.[1];
    assert.ok(json, "Chrome returns measurements of production markup");
    const measured = JSON.parse(json.replaceAll("&quot;", '"').replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">"));
    assert.equal(measured.error, undefined, "browser measurement script completes");
    assert.equal(measured.viewportWidth, width, "layout uses the named viewport width");
    return measured as T;
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
