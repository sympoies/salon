import { isMacTauri } from "./runtime.ts";

export function installMacTitleBar(): void {
  if (isMacTauri()) document.documentElement.dataset.macTitlebar = "true";
}

/** Native decorations retain the traffic lights; only the title area is Web content. */
export function MacTitleBar() {
  if (!isMacTauri()) return null;
  return <div className="mac-titlebar" data-tauri-drag-region="">
    <span data-tauri-drag-region="">Agent Console</span>
    <div id="mac-titlebar-counts" />
    <div className="mac-titlebar-space" data-tauri-drag-region="" />
  </div>;
}
