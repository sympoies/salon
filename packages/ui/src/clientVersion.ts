import { isAndroidTauri, isMacTauri, isTauri } from "./runtime.ts";

declare const __AGENT_CONSOLE_APP_VERSION__: string | undefined;
declare const __AGENT_CONSOLE_BUILD_SHA__: string | undefined;

export interface ClientVersionInfo {
  readonly version: string | null;
  readonly build: string | null;
  readonly surface: "web" | "macos" | "android" | "tauri";
}

export function clientVersionInfo(): ClientVersionInfo {
  const version = typeof __AGENT_CONSOLE_APP_VERSION__ === "string"
    ? __AGENT_CONSOLE_APP_VERSION__.trim() : "";
  const build = typeof __AGENT_CONSOLE_BUILD_SHA__ === "string"
    ? __AGENT_CONSOLE_BUILD_SHA__.trim() : "";
  return {
    version: version || null,
    build: build ? build.slice(0, 12) : null,
    surface: !isTauri() ? "web" : isAndroidTauri() ? "android" : isMacTauri() ? "macos" : "tauri",
  };
}

/** Select only build metadata, never the broader diagnostic context. */
export function versionCopyText(info: ClientVersionInfo, server: { version?: string; build?: string } = {}): string {
  return `Client version: ${info.version ?? "Unavailable"}\nClient build: ${info.build ?? "Unavailable"}\nSurface: ${info.surface}`
    + (server.version ? `\nServer version: ${server.version}` : "")
    + (server.build ? `\nServer build: ${server.build}` : "");
}
