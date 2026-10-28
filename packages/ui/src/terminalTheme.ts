import type { ITheme } from "@xterm/xterm";
import type { ResolvedTheme } from "./theme.ts";

// The canvas colours equal the page canvas (THEME_META_COLORS) so the pane
// shows no seam against the surface around it.
const NIGHT_OWL: ITheme = {
  background: "#011627",
  foreground: "#d6deeb",
  cursor: "#bec5d4",
  cursorAccent: "#011627",
  selectionBackground: "#637777",
  selectionForeground: "#ffffff",
  black: "#011627",
  red: "#f78c6c",
  green: "#addb67",
  yellow: "#ffcb8b",
  blue: "#82aaff",
  magenta: "#c792ea",
  cyan: "#7fdbca",
  white: "#bec5d4",
  brightBlack: "#44596b",
  brightRed: "#ef5350",
  brightGreen: "#22da6e",
  brightYellow: "#ffeb95",
  brightBlue: "#5ca7e4",
  brightMagenta: "#7e57c2",
  brightCyan: "#21c7a8",
  brightWhite: "#ffffff",
};

// Paper: ink on the warm canvas. Every ANSI colour reads at 4.5:1 or more on the
// canvas, so programs that print "white" or a pale bright colour stay legible.
const PAPER: ITheme = {
  background: "#f4f3ed",
  foreground: "#1f2520",
  cursor: "#1f2520",
  cursorAccent: "#f4f3ed",
  selectionBackground: "#b9cdea",
  selectionForeground: "#1f2520",
  black: "#1f2520",
  red: "#a43c2e",
  green: "#2d6c3f",
  yellow: "#855b00",
  blue: "#2457a7",
  magenta: "#7a3e9d",
  cyan: "#0c655b",
  white: "#5d645c",
  brightBlack: "#5f665e",
  brightRed: "#b3321f",
  brightGreen: "#1f7a45",
  brightYellow: "#7a5400",
  brightBlue: "#1a4fa0",
  brightMagenta: "#6f3593",
  brightCyan: "#0a6b7a",
  brightWhite: "#1f2520",
};

export function terminalThemeFor(theme: ResolvedTheme): ITheme {
  return theme === "paper" ? PAPER : NIGHT_OWL;
}

/** The palette plus the renderer's contrast policy for one resolved theme. */
export interface TerminalAppearance {
  readonly theme: ITheme;
  readonly minimumContrastRatio: number;
}

// Paper's default foreground is ANSI black, so ESC[40m (black background, default
// foreground) would hide its text. xterm raises the foreground of any cell below
// this ratio, which keeps programs' background cells readable. Dark keeps xterm's
// default of 1 (no adjustment), so its rendering is unchanged.
export function terminalAppearanceFor(theme: ResolvedTheme): TerminalAppearance {
  return { theme: terminalThemeFor(theme), minimumContrastRatio: theme === "paper" ? 4.5 : 1 };
}
