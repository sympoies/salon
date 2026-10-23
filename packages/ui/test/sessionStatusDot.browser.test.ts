import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ComponentType } from "react";
import type { SessionActivityPopoverProps } from "../src/SessionActivityPopover.tsx";
import { makeSession } from "./support/fixtures.ts";
import { createUiSsrHarness, renderComponent } from "./support/ssr.ts";

const ssr = createUiSsrHarness();
after(async () => ssr.close());

test("real header shows a neutral unknown ring for expired provider evidence and unknown phase (#873)", async t => {
  const chrome = process.env.CHROME_BIN ?? "google-chrome";
  const probe = spawnSync(chrome, ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) { t.skip("headless Chrome unavailable"); return; }
  const now = "2026-10-08T06:40:00Z";
  const module = await ssr.loadModule<{ SessionActivityPopover: ComponentType<SessionActivityPopoverProps> }>("/src/SessionActivityPopover.tsx");
  const markup = (["working", "unknown"] as const).map(phase => renderComponent(module.SessionActivityPopover, {
    session: makeSession({ agent: "claude", activity_observed_at: now, last_terminal_activity_at: "2026-10-08T06:39:55Z", turn_state: {
      schema_version: "agent-session.turn-state.v1", phase, phase_changed_at: "2026-10-08T06:00:00Z", revision: 1,
      source: { kind: "provider_hook", provider: "claude", confidence: "observed" },
      semantic_event: { kind: "progress", observed_at: "2026-10-08T06:30:00Z" },
      current_turn: { started_at: "2026-10-08T06:39:00Z" },
    } }), machineReachable: true, focused: false, clockActive: false, nowMs: Date.parse(now),
  })).join("");
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const temp = mkdtempSync(join(tmpdir(), "agent-console-status-dot-"));
  try {
    const path = join(temp, "header.html");
    writeFileSync(path, `<!doctype html><style>${css}</style>${markup}<script>
      const result=[...document.querySelectorAll('.session-activity-trigger')].map(trigger=>{
        const icon=trigger.querySelector('.card-status-icon'),circle=icon.querySelector('circle');
        return {label:trigger.getAttribute('aria-label'),title:trigger.title,kind:trigger.className,
          circles:icon.querySelectorAll('circle').length,paths:icon.querySelectorAll('path').length,
          fill:circle?getComputedStyle(circle).fill:null,color:getComputedStyle(icon).color,dash:circle?getComputedStyle(circle).strokeDasharray:null,ring:getComputedStyle(trigger.querySelector('.session-activity-marker'),'::after').content,
          hidden:icon.getAttribute('aria-hidden'),timer:trigger.querySelector('.session-activity-text').textContent};
      });
      const output=document.createElement('pre');output.id='measurement';output.textContent=JSON.stringify(result);document.body.append(output);
    </script>`);
    const run = spawnSync(chrome, ["--headless", "--disable-gpu", "--no-sandbox", "--window-size=1280,800", "--dump-dom", `file://${path}`], { encoding: "utf8", timeout: 15_000 });
    assert.equal(run.status, 0, `Chrome failed: ${run.stderr}`);
    const json = run.stdout.match(/<pre id="measurement">(.*?)<\/pre>/s)?.[1];
    assert.ok(json, "Chrome returns actual header measurements");
    const results = JSON.parse(json) as Array<{ label: string; title: string; kind: string; circles: number; paths: number; fill: string; color: string; dash: string; ring: string; hidden: string; timer: string }>;
    assert.equal(results.length, 2);
    for (const [index, result] of results.entries()) {
      const reason = index === 0 ? "provider status expired" : "provider status unavailable";
      assert.equal(result.label, `Session activity: State unknown: ${reason}`);
      assert.equal(result.title, `State unknown: ${reason}`);
      assert.match(result.kind, /card-state-unknown/);
      if (index === 0) assert.match(result.kind, /activity-working-uncertain.*has-ripple/);
      assert.equal(result.paths, 0, "question-mark path is absent");
      assert.equal(result.circles, 1, "status is one ring");
      assert.equal(result.fill, "none", "unknown status is hollow, not a filled request dot");
      assert.notEqual(result.dash, "none", "unknown status is a dashed ring");
      assert.equal(result.color, "rgb(143, 163, 191)", "unknown status is neutral, not the orange warning color");
      assert.equal(result.ring, "none", "unknown status has no outer ripple ring");
      assert.equal(result.hidden, "true", "accessible state comes from the descriptive button label");
      assert.equal(result.timer, index === 0 ? "0m" : "10m",
        index === 0 ? "expired evidence keeps the successful observation" : "an unknown phase is timed from its last evidence");
    }
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
