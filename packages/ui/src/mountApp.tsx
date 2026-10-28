import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { createUiExtensionRegistry, UiExtensionsProvider, type UiExtension } from "./extensions.tsx";
import { installAndroidSafeAreaInsets } from "./runtime.ts";
import { installMacTitleBar, MacTitleBar } from "./MacTitleBar.tsx";
import { installTheme } from "./theme.ts";
import "./styles.css";

export interface MountAppOptions {
  /** Extensions from the distribution entry; core's own entry passes none. */
  readonly extensions?: readonly UiExtension[];
}

/** Render the console into `root`. Registry validation fails before anything renders. */
export function mountApp(root: HTMLElement | null, options: MountAppOptions = {}): void {
  if (!root) {
    throw new Error("agent-console: #root element missing");
  }
  const registry = createUiExtensionRegistry(options.extensions ?? []);
  installTheme();
  installAndroidSafeAreaInsets();
  installMacTitleBar();
  createRoot(root).render(
    <StrictMode>
      <MacTitleBar />
      <UiExtensionsProvider registry={registry}>
        <App />
      </UiExtensionsProvider>
    </StrictMode>,
  );
}
