import { useContext } from "react";
import { AppNameContext } from "./appName.ts";
import { isMacTauri } from "./runtime.ts";

export function installMacTitleBar(): void {
  if (isMacTauri()) document.documentElement.dataset.macTitlebar = "true";
}

/** Native decorations retain the traffic lights; only the title area is Web content. */
export function MacTitleBar() {
  const appName = useContext(AppNameContext);
  if (!isMacTauri()) return null;
  return <div className="mac-titlebar" data-tauri-drag-region="">
    <span data-tauri-drag-region="">{appName}</span>
    <div id="mac-titlebar-counts" />
    <div className="mac-titlebar-space" data-tauri-drag-region="" />
    <div id="mac-titlebar-notice" />
  </div>;
}
