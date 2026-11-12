import type { ReactNode } from "react";
import { ReorderList } from "./ReorderList.tsx";

/** The Machines list: host names in the device's order, each with its own actions. */
export function MachineOrderList({ machines, onReorder, renderActions }: {
  readonly machines: readonly string[];
  readonly onReorder: (order: readonly string[]) => void;
  readonly renderActions: (machine: string) => ReactNode;
}) {
  return (
    <ReorderList
      items={machines}
      itemKey={machine => machine}
      renderLabel={machine => machine}
      renderActions={renderActions}
      onReorder={onReorder}
    />
  );
}
