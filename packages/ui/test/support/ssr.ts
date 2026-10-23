import { mkdirSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import react from "@vitejs/plugin-react";
import { createServer as createViteServer, type InlineConfig, type Plugin } from "vite";

export interface UiSsrHarness {
  loadModule<T extends Record<string, unknown>>(path: string): Promise<T>;
  close(): Promise<void>;
}

import type { UiExtension } from "../../src/extensions.tsx";

export interface UiSsrHarnessOptions {
  readonly extensions?: readonly UiExtension[];
  readonly plugins?: readonly Plugin[];
  readonly ssr?: InlineConfig["ssr"];
  readonly createServer?: UiSsrServerFactory;
}

interface UiSsrServer {
  ssrLoadModule(path: string): Promise<unknown>;
  close(): Promise<void>;
}

type UiSsrServerFactory = (config: InlineConfig) => Promise<UiSsrServer>;

const uiSsrServerConfig = {
  middlewareMode: true,
  hmr: false,
  ws: false,
} as const satisfies NonNullable<InlineConfig["server"]>;

const uiSsrOptimizeDepsConfig = {
  noDiscovery: true,
  include: [],
} as const satisfies NonNullable<InlineConfig["optimizeDeps"]>;

export function createUiSsrHarness(options: readonly Plugin[] | UiSsrHarnessOptions = []): UiSsrHarness {
  const plugins = Array.isArray(options) ? options : (options.plugins ?? []);
  const ssr = Array.isArray(options) ? undefined : options.ssr;
  const createServer = Array.isArray(options) ? createViteServer : (options.createServer ?? createViteServer);
  const cacheRoot = fileURLToPath(new URL("../../node_modules/.vite", import.meta.url));
  let cacheDir: string | null = null;
  let server: UiSsrServer | null = null;
  let serverPromise: Promise<UiSsrServer> | null = null;
  const activeLoads = new Set<Promise<unknown>>();
  const composedModules = new Map<string, Record<string, unknown>>();
  let closePromise: Promise<void> | null = null;
  let closing = false;
  const ensureCache = () => {
    if (cacheDir === null) {
      mkdirSync(cacheRoot, { recursive: true });
      cacheDir = mkdtempSync(join(cacheRoot, "vite-ssr-"));
    }
    return cacheDir;
  };
  const removeCache = async () => {
    const target = cacheDir;
    cacheDir = null;
    if (target !== null) {
      await rm(target, { recursive: true, force: true });
    }
  };
  const initializeServer = async () => {
    let pending: Promise<UiSsrServer> | null = null;
    try {
      pending = createServer({
        root: fileURLToPath(new URL("../..", import.meta.url)),
        cacheDir: ensureCache(),
        configFile: false,
        appType: "custom",
        optimizeDeps: uiSsrOptimizeDepsConfig,
        plugins: [...plugins, react()],
        ssr,
        server: uiSsrServerConfig,
      });
      serverPromise = pending;
      server = await pending;
      return server;
    } catch (error) {
      await removeCache();
      throw error;
    } finally {
      if (pending !== null && serverPromise === pending) {
        serverPromise = null;
      }
    }
  };
  return {
    async loadModule<T extends Record<string, unknown>>(path: string): Promise<T> {
      if (closing) {
        throw new Error("UI SSR harness is closing");
      }
      const load = (async () => {
        const activeServer = server ?? await (serverPromise ?? initializeServer());
        const loaded = await activeServer.ssrLoadModule(path) as T;
        const contributions = Array.isArray(options) ? undefined : options.extensions;
        if (!contributions || !/\/(SessionSlot|MobileSessionList)\.tsx$/.test(path)) return loaded;
        if (!composedModules.has(path)) {
          const { UiExtensionsProvider, createUiExtensionRegistry } = await activeServer.ssrLoadModule("/src/extensions.tsx") as typeof import("../../src/extensions.tsx");
          const registry = createUiExtensionRegistry(contributions);
          const composed = { ...loaded };
          for (const name of ["SessionSlot", "MobileSessionList"]) {
            if (!loaded[name]) continue;
            const Consumer = loaded[name] as ComponentType<Record<string, unknown>>;
            composed[name] = (props: Record<string, unknown>) => createElement(UiExtensionsProvider, { registry }, createElement(Consumer, props));
          }
          composedModules.set(path, composed);
        }
        return composedModules.get(path) as T;
      })();
      activeLoads.add(load);
      try {
        return await load;
      } finally {
        activeLoads.delete(load);
      }
    },
    async close(): Promise<void> {
      if (closePromise !== null) {
        await closePromise;
        return;
      }
      closing = true;
      const close = (async () => {
        await Promise.allSettled([...activeLoads]);
        const activeServer = server;
        server = null;
        serverPromise = null;
        try {
          composedModules.clear();
          await activeServer?.close();
        } finally {
          await removeCache();
        }
      })();
      closePromise = close;
      try {
        await close;
      } finally {
        if (closePromise === close) {
          closePromise = null;
          closing = false;
        }
      }
    },
  };
}

export function renderComponent<P extends object>(Component: ComponentType<P>, props: P): string {
  return renderToStaticMarkup(createElement(Component, props));
}
