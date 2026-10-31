import { createContext } from "react";
import salonMarkDarkUrl from "./assets/salon-mark-dark.svg";
import salonMarkLightUrl from "./assets/salon-mark-light.svg";

/** URLs of one mark: `dark` for dark surfaces, `light` for light and Paper surfaces. */
export interface AppIcon {
  readonly dark: string;
  readonly light: string;
}

export const DEFAULT_APP_ICON: AppIcon = { dark: salonMarkDarkUrl, light: salonMarkLightUrl };
export const AppIconContext = createContext<AppIcon>(DEFAULT_APP_ICON);
