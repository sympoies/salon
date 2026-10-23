import { strict as assert } from "node:assert";
import { access, mkdir, writeFile } from "node:fs/promises";
import { test } from "node:test";
import type { InlineConfig } from "vite";
import { createUiSsrHarness } from "./support/ssr.ts";

test("UI SSR harnesses isolate and clean dependency caches while disabling runtime discovery", async () => {
  const capturedConfigs: InlineConfig[] = [];
  const options = {
    createServer: async (config: InlineConfig) => {
      capturedConfigs.push(config);
      return {
        async ssrLoadModule() {
          return {};
        },
        async close() {},
      };
    },
  };
  const first = createUiSsrHarness(options);
  const second = createUiSsrHarness(options);

  await first.loadModule("./src/api.ts");
  await second.loadModule("./src/api.ts");

  assert.deepEqual(capturedConfigs[0]?.server, {
    middlewareMode: true,
    hmr: false,
    ws: false,
  });
  assert.deepEqual(capturedConfigs[0]?.optimizeDeps, {
    noDiscovery: true,
    include: [],
  });
  const cacheDirs = capturedConfigs.map((config) => config.cacheDir ?? "");
  assert.equal(cacheDirs.length, 2);
  assert.notEqual(cacheDirs[0], cacheDirs[1]);
  for (const cacheDir of cacheDirs) {
    assert.match(cacheDir, /\/vite-ssr-/);
    await mkdir(cacheDir, { recursive: true });
    await writeFile(`${cacheDir}/sentinel`, "test");
  }

  await first.close();
  await second.close();
  for (const cacheDir of cacheDirs) {
    await assert.rejects(access(cacheDir), { code: "ENOENT" });
  }
});

test("UI SSR harness removes its dependency cache when server creation fails", async () => {
  let cacheDir = "";
  let releaseServer!: () => void;
  const serverGate = new Promise<void>((resolve) => {
    releaseServer = resolve;
  });
  const ssr = createUiSsrHarness({
    createServer: async (config: InlineConfig) => {
      cacheDir = config.cacheDir ?? "";
      await mkdir(cacheDir, { recursive: true });
      await writeFile(`${cacheDir}/sentinel`, "test");
      await serverGate;
      throw new Error("create failed");
    },
  });

  const load = ssr.loadModule("./src/api.ts");
  const close = ssr.close();
  releaseServer();
  await assert.rejects(load, /create failed/);
  await close;
  assert.notEqual(cacheDir, "");
  await assert.rejects(access(cacheDir), { code: "ENOENT" });
});

test("UI SSR harness removes its dependency cache when the server factory throws synchronously", async () => {
  let cacheDir = "";
  const ssr = createUiSsrHarness({
    createServer: (config: InlineConfig) => {
      cacheDir = config.cacheDir ?? "";
      throw new Error("create threw");
    },
  });

  try {
    await assert.rejects(ssr.loadModule("./src/api.ts"), /create threw/);
    assert.notEqual(cacheDir, "");
    await assert.rejects(access(cacheDir), { code: "ENOENT" });
  } finally {
    await ssr.close();
  }
});

test("UI SSR harness shares one server initialization across concurrent module loads", async () => {
  let createCalls = 0;
  let closeCalls = 0;
  let cacheDir = "";
  let releaseServer!: () => void;
  const serverGate = new Promise<void>((resolve) => {
    releaseServer = resolve;
  });
  const ssr = createUiSsrHarness({
    createServer: async (config: InlineConfig) => {
      const serverId = ++createCalls;
      cacheDir = config.cacheDir ?? "";
      await mkdir(cacheDir, { recursive: true });
      await serverGate;
      return {
        async ssrLoadModule() {
          return { serverId };
        },
        async close() {
          closeCalls += 1;
        },
      };
    },
  });

  const firstLoad = ssr.loadModule<{ serverId: number }>("./src/api.ts");
  const secondLoad = ssr.loadModule<{ serverId: number }>("./src/headerUsageModel.ts");
  releaseServer();
  const modules = await Promise.all([firstLoad, secondLoad]);

  assert.equal(createCalls, 1);
  assert.deepEqual(modules.map(({ serverId }) => serverId), [1, 1]);
  await ssr.close();
  assert.equal(closeCalls, 1);
  await assert.rejects(access(cacheDir), { code: "ENOENT" });
});

test("UI SSR harness waits for an in-flight module load before closing its server", async () => {
  const events: string[] = [];
  let cacheDir = "";
  let closed = false;
  let releaseServer!: () => void;
  const serverGate = new Promise<void>((resolve) => {
    releaseServer = resolve;
  });
  const ssr = createUiSsrHarness({
    createServer: async (config: InlineConfig) => {
      cacheDir = config.cacheDir ?? "";
      await mkdir(cacheDir, { recursive: true });
      events.push("create:start");
      await serverGate;
      events.push("create:done");
      return {
        async ssrLoadModule() {
          assert.equal(closed, false);
          events.push("load");
          return {};
        },
        async close() {
          closed = true;
          events.push("close");
        },
      };
    },
  });

  const load = ssr.loadModule("./src/api.ts");
  const close = ssr.close();
  releaseServer();
  await Promise.all([load, close]);

  assert.deepEqual(events, ["create:start", "create:done", "load", "close"]);
  await assert.rejects(access(cacheDir), { code: "ENOENT" });
});
