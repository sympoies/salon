import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { Plugin } from "vite";
import { createUiSsrHarness } from "./support/ssr.ts";

const icon = { dark: "/host-mark-dark.svg", light: "/host-mark-light.svg" };
// Small SVG assets are inlined as data URIs; each master names its gradient after its variant.
const iconSources = (markup: string) => [...markup.matchAll(/<img class="brand-title-icon" src="([^"]*)"/g)].map(match => match[1]);

test("the bundled Salon marks match the brand masters", () => {
  for (const theme of ["dark", "light"]) {
    const bundled = readFileSync(new URL(`../src/assets/salon-mark-${theme}.svg`, import.meta.url));
    const master = readFileSync(new URL(`../../../assets/brand/salon-mark-${theme}.svg`, import.meta.url));
    assert.deepEqual(bundled, master);
  }
});

test("Login, Settings and Dashboard render the Salon mark by default and a host appIcon when passed", async () => {
  const harness = createUiSsrHarness([{ name: "icon-terminal-boundary", enforce: "pre",
    resolveId(source) { if (source.endsWith("TerminalPane.tsx")) return "\0icon-terminal"; },
    load(id) { if (id === "\0icon-terminal") return "export const TerminalPane = () => null;"; },
  }]);
  try {
    const { AppIconContext } = await harness.loadModule<typeof import("../src/appIcon.ts")>("/src/appIcon.ts");
    const { BrandMark } = await harness.loadModule<typeof import("../src/BrandTitle.tsx")>("/src/BrandTitle.tsx");
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
      createElement(BrandMark),
    ];
    for (const screen of screens) {
      const [fallback] = iconSources(renderToStaticMarkup(screen));
      assert.match(fallback ?? "", /salon-dark-flow/);
      assert.deepEqual(iconSources(renderToStaticMarkup(createElement(AppIconContext.Provider, { value: icon }, screen))).slice(0, 1), [icon.dark]);
    }
  } finally { await harness.close(); }
});

for (const [mode, expected] of [["dark", icon.dark], ["paper", icon.light]] as const) {
  test(`the mounted entry shows the ${mode} variant of the default and passed marks`, async () => {
    for (const appIcon of [undefined, icon]) {
      const window = new Window({ url: "http://localhost" });
      window.localStorage.setItem("ac.themeMode", mode);
      const keys = ["window", "document", "navigator", "HTMLElement", "Element", "localStorage", "IS_REACT_ACT_ENVIRONMENT", "__iconCreateRoot"];
      const previous = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
      let mounted: Root | undefined;
      const globals: Record<string, unknown> = { window, document: window.document, navigator: window.navigator,
        HTMLElement: window.HTMLElement, Element: window.Element, localStorage: window.localStorage,
        IS_REACT_ACT_ENVIRONMENT: true, __iconCreateRoot: (container: HTMLElement) => (mounted = createRoot(container)) };
      keys.forEach(key => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: globals[key] }));
      const container = window.document.createElement("div"); window.document.body.append(container);
      const boundary: Plugin = { name: "icon-entry-app-boundary", enforce: "pre",
        resolveId(source, importer) {
          if (!/\/mountApp\.tsx$/.test(importer ?? "")) return;
          if (source === "./App") return "\0icon-app";
          if (source === "react-dom/client") return "\0icon-root";
        },
        load(id) {
          if (id === "\0icon-app") return 'import React from "react";import { BrandTitle } from "/src/BrandTitle.tsx";export default function App(){return React.createElement(BrandTitle);}';
          if (id === "\0icon-root") return 'export const createRoot=(...args)=>globalThis.__iconCreateRoot(...args);';
        },
      };
      const harness = createUiSsrHarness([boundary]);
      try {
        await act(async () => { const { mountApp } = await harness.loadModule<typeof import("../src/mountApp.tsx")>("/src/mountApp.tsx"); mountApp(container, appIcon ? { appIcon } : {}); });
        const src = container.querySelector("img.brand-title-icon")?.getAttribute("src") ?? "";
        if (appIcon) assert.equal(src, expected);
        else assert.match(src, new RegExp(`salon-${mode === "dark" ? "dark" : "light"}-flow`));
      } finally {
        await act(async () => mounted?.unmount());
        await harness.close(); await window.happyDOM.close();
        keys.forEach((key, index) => previous[index] ? Object.defineProperty(globalThis, key, previous[index]!) : Reflect.deleteProperty(globalThis, key));
      }
    }
  });
}
