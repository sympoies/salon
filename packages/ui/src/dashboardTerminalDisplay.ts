import { BASE_TERMINAL_FONT_SIZE } from "./terminalFit.ts";

export interface DashboardTerminalDisplay {
  readonly fontSize: number;
  readonly readableFit: boolean;
}

export function resolveDashboardTerminalDisplay({
  focusedKey,
}: {
  readonly focusedKey: string | null;
}): DashboardTerminalDisplay {
  return {
    fontSize: BASE_TERMINAL_FONT_SIZE,
    readableFit: focusedKey !== null,
  };
}
