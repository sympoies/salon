import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createUiSsrHarness } from "./support/ssr.ts";

test("Login, Settings, and Dashboard show the configured and default app name", async () => {
  const harness = createUiSsrHarness([{ name: "title-terminal-boundary", enforce: "pre",
    resolveId(source) { if (source.endsWith("TerminalPane.tsx")) return "\0title-terminal"; },
    load(id) { if (id === "\0title-terminal") return "export const TerminalPane = () => null;"; },
  }]);
  try {
    const { AppNameContext } = await harness.loadModule<typeof import("../src/appName.ts")>("/src/appName.ts");
    const { Login } = await harness.loadModule<typeof import("../src/Login.tsx")>("/src/Login.tsx");
    const { Settings } = await harness.loadModule<typeof import("../src/Settings.tsx")>("/src/Settings.tsx");
    const { Dashboard } = await harness.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
    const noop = () => {};
    const screens = [
      createElement(Login, { onSignedIn: noop }),
      createElement(Settings, { variant: "connect", onSaved: noop, machines: [], machineColors: {}, defaultAutoResume: false,
        attentionAlerts: false, terminalRenderMode: "realtime", terminalSelectedPaneRealtime: true,
        onMachineColorChange: noop, onMachineColorReset: noop, onDefaultAutoResumeChange: noop,
        onAttentionAlertsChange: noop, onTerminalRenderModeChange: noop, onTerminalSelectedPaneRealtimeChange: noop,
        openAccess: true, onSignedOut: noop }),
      createElement(Dashboard, { active: false, machines: [], enabledMachines: [], machineColors: {},
        defaultAutoResume: false, terminalRenderMode: "realtime", terminalSelectedPaneRealtime: true,
        onDebug: noop, onUsage: noop, onSettings: noop }),
    ];
    for (const screen of screens) {
      assert.match(renderToStaticMarkup(screen), /<h1>Agent Console<\/h1>/);
      assert.match(renderToStaticMarkup(createElement(AppNameContext.Provider, { value: "Agent Console Test" }, screen)), /<h1>Agent Console Test<\/h1>/);
    }
  } finally { await harness.close(); }
});
