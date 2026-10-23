import type { CSSProperties } from "react";
import { useUiExtensions } from "./extensions.tsx";
import { machineColorRgb, resolveMachineColor, type MachineColorMap } from "./machineColors.ts";

interface MachineBadgeProps {
  readonly machine: string;
  readonly machineColors: MachineColorMap;
}

// Decorative machine mark: the same circular footprint as AgentBadge, carrying
// the machine's accent colour instead of a provider glyph. Always aria-hidden —
// every surface that shows it already names the machine in text.
export function MachineBadge({ machine, machineColors }: MachineBadgeProps) {
  const color = resolveMachineColor(machine, machineColors, useUiExtensions().machineColorDefaults);
  return (
    <span
      className="machine-badge"
      style={{
        "--machine-accent": color,
        "--machine-accent-rgb": machineColorRgb(color),
      } as CSSProperties}
      aria-hidden="true"
    >
      <span className="machine-badge-dot" />
    </span>
  );
}
