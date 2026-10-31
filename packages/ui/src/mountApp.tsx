import { AppIconContext, DEFAULT_APP_ICON, type AppIcon } from "./appIcon.ts";
import { AppNameContext } from "./appName.ts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { createUiExtensionRegistry, UiExtensionsProvider, type UiExtension } from "./extensions.tsx";
import { installAndroidSafeAreaInsets } from "./runtime.ts";
import { installMacTitleBar, MacTitleBar } from "./MacTitleBar.tsx";
import { installTheme } from "./theme.ts";
import "./styles.css";

export interface MountAppOptions {
  /** Name displayed in the application title. Defaults to Agent Console. */
  readonly appName?: string;
  /** Header mark: `dark` for dark surfaces, `light` for light and Paper surfaces. Defaults to the Salon mark. */
  readonly appIcon?: AppIcon;
  /** Extensions from the distribution entry; core's own entry passes none. */
  readonly extensions?: readonly UiExtension[];
}

/** Render the console into `root`. Registry validation fails before anything renders. */
export function mountApp(root: HTMLElement | null, options: MountAppOptions = {}): void {
  if (!root) {
    throw new Error("agent-console: #root element missing");
  }
  const registry = createUiExtensionRegistry(options.extensions ?? []);
  if (options.appName !== undefined) document.title = options.appName;
  installTheme();
  installAndroidSafeAreaInsets();
  installMacTitleBar();
  createRoot(root).render(
    <StrictMode>
      <AppNameContext.Provider value={options.appName ?? "Agent Console"}>
        <AppIconContext.Provider value={options.appIcon ?? DEFAULT_APP_ICON}>
          <MacTitleBar />
          <UiExtensionsProvider registry={registry}>
            <App />
          </UiExtensionsProvider>
        </AppIconContext.Provider>
      </AppNameContext.Provider>
    </StrictMode>,
  );
}
