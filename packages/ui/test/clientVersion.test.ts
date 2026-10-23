import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";
import { clientVersionInfo, versionCopyText } from "../src/clientVersion.ts";

const globals = globalThis as typeof globalThis & {
  __AGENT_CONSOLE_APP_VERSION__?: string;
  __AGENT_CONSOLE_BUILD_SHA__?: string;
};
afterEach(() => {
  delete globals.__AGENT_CONSOLE_APP_VERSION__;
  delete globals.__AGENT_CONSOLE_BUILD_SHA__;
});

test("client version uses injected metadata and a short build without consulting the server", () => {
  globals.__AGENT_CONSOLE_APP_VERSION__ = "0.3.30";
  globals.__AGENT_CONSOLE_BUILD_SHA__ = "ad41d7963b261dd51261f7259376e09bc510d8ad";
  assert.deepEqual(clientVersionInfo(), { version: "0.3.30", build: "ad41d7963b26", surface: "web" });
});

test("missing and empty build metadata is explicitly unavailable, never a guessed release", () => {
  assert.deepEqual(clientVersionInfo(), { version: null, build: null, surface: "web" });
  globals.__AGENT_CONSOLE_APP_VERSION__ = "";
  globals.__AGENT_CONSOLE_BUILD_SHA__ = "";
  assert.deepEqual(clientVersionInfo(), { version: null, build: null, surface: "web" });
  assert.equal(versionCopyText(clientVersionInfo()), "Client version: Unavailable\nClient build: Unavailable\nSurface: web");
});

test("version copy selects only version/build/surface even if the input contains diagnostic secrets", () => {
  const info = {
    version: "0.3.30", build: "ad41d7963b26", surface: "web" as const,
    token: "test-token", account: "test-account", url: "https://example.test/private",
    user_agent: "test-agent", environment: "test-environment",
  };
  assert.equal(versionCopyText(info), "Client version: 0.3.30\nClient build: ad41d7963b26\nSurface: web");
});

test("version surface follows the existing Android and macOS runtime adapters", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  try {
    for (const [userAgent, surface] of [["Android test", "android"], ["Desktop test", "macos"]]) {
      Object.defineProperty(globalThis, "window", { configurable: true, value: {
        location: { protocol: "tauri:", hostname: "tauri.localhost" },
        navigator: { userAgent },
      } });
      assert.equal(clientVersionInfo().surface, surface);
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
