import { AppSelect } from "./AppSelect.tsx";
import { MachineIcon, SelectChevronIcon } from "./icons.tsx";
import { isAndroidTauri } from "./runtime.ts";

/** The focused header's host picker. The Android themed menu draws its own chevron. */
export function MachineFilter({ value, machines, allValue, onChange }: {
  readonly value: string;
  readonly machines: readonly string[];
  readonly allValue: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <label className="machine-filter">
      <MachineIcon />
      <AppSelect className="machine-filter-select" aria-label="Filter sessions by machine" value={value}
        onChange={(event) => onChange(event.target.value)}>
        <option value={allValue}>All machines</option>
        {machines.map((machine) => <option key={machine} value={machine}>{machine}</option>)}
      </AppSelect>
      {isAndroidTauri() ? null : <SelectChevronIcon />}
    </label>
  );
}
