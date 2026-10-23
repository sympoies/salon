import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import { consoleViteConfig } from "./vite.shared.ts";

const appPackage = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
export default defineConfig(consoleViteConfig({ outDir: "dist", appVersion: appPackage.version }));
