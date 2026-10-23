import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { controlSizeFixture, sizeMeasurementScript } from "./support/controlSizeFixture.ts";
const root = process.env.SIZE_AUDIT_ROOT ?? new URL("../", import.meta.url).pathname;
const out = process.env.SIZE_AUDIT_OUT;
if (!out) throw new Error("Set SIZE_AUDIT_OUT to an agent-out artifact prefix");
const measurements = [];
for (const width of [360,412,1280]) {
  const markup = await controlSizeFixture(width, root);
  const css = readFileSync(`${root}/src/styles.css`, "utf8");
  const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style>${markup}<script>${sizeMeasurementScript};parent.document.body.dataset.metrics=btoa(JSON.stringify(result));</script>`;
  writeFileSync(`${out}-${width}.html`, html);
  // An iframe gives an exact phone viewport despite Chrome's top-level minimum width.
  writeFileSync(`${out}-${width}-frame.html`, `<!doctype html><style>body{margin:0}iframe{border:0;display:block}</style><body><script>const frame=document.createElement('iframe');frame.width='${width}';frame.height='1050';frame.srcdoc=${JSON.stringify(html).replaceAll("<", "\\u003c")};document.body.append(frame);</script>`);
  const p = spawnSync("google-chrome", ["--headless","--no-sandbox","--allow-file-access-from-files","--disable-gpu","--hide-scrollbars","--force-dark-mode",...(width < 761 ? ["--blink-settings=primaryPointerType=2,availablePointerTypes=2"] : []),"--virtual-time-budget=3000",`--window-size=${Math.max(width,500)},1050`, `--screenshot=${out}-${width}.png`,"--dump-dom",`file://${out}-${width}-frame.html`],{encoding:"utf8",timeout:20000});
  if(p.status !== 0) throw new Error(p.stderr);
  const encoded = p.stdout.match(/data-metrics="([^"]+)"/)?.[1];
  if(!encoded) throw new Error("No rendered metrics");
  measurements.push({width,...JSON.parse(Buffer.from(encoded,"base64").toString())});
}
writeFileSync(`${out}.json`, JSON.stringify(measurements,null,2));
