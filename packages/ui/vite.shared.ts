import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { UserConfig } from "vite";
import react from "@vitejs/plugin-react";

export interface ConsoleViteOptions {
  /** Directory holding the page's index.html. */
  readonly root?: string;
  readonly outDir: string;
  readonly publicDir?: string;
  /** The distribution owns its app version, independently of the core package. */
  readonly appVersion?: string;
}

const buildSha = process.env.AGENT_CONSOLE_BUILD_SHA ?? process.env.GITHUB_SHA ?? gitHead() ?? "";

// The Vite settings every console page build shares: core's own page and the
// distribution page. Relative base so the built dist/ can be served from any
// path — by the edge backend's static-serve, or embedded in the Tauri APK.
export function consoleViteConfig(options: ConsoleViteOptions): UserConfig {
  return {
    plugins: [react()],
    base: "./",
    ...(options.root ? { root: options.root } : {}),
    publicDir: options.publicDir ?? fileURLToPath(new URL("./public", import.meta.url)),
    define: {
      __AGENT_CONSOLE_APP_VERSION__: JSON.stringify(options.appVersion ?? "0.0.0"),
      __AGENT_CONSOLE_BUILD_SHA__: JSON.stringify(buildSha),
    },
    build: {
      outDir: options.outDir,
      emptyOutDir: true,
      target: "es2022",
    },
  };
}

function gitHead(): string | null {
  try {
    return execSync("git rev-parse --short=12 HEAD", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}
