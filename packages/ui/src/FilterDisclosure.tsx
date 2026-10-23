import { useId, useState, type ReactNode } from "react";
import { SelectChevronIcon } from "./icons.tsx";

/** Shared filter summary; controls stay mounted so folding preserves their state. */
export function FilterDisclosure({ id, summary, children, className = "" }: {
  readonly id?: string;
  readonly summary: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const generatedId = useId();
  const controlsId = id ?? generatedId;
  const [open, setOpen] = useState(false);
  return (
    <section className={`filter-disclosure ${className}`} aria-label="Filters">
      <button type="button" className="control-row filter-disclosure-toggle"
        aria-expanded={open} aria-controls={controlsId} onClick={() => setOpen(value => !value)}>
        <strong>Filters{" "}</strong>
        <span className="filter-disclosure-summary">{summary}</span>
        <SelectChevronIcon className="filter-disclosure-chevron" />
      </button>
      <div id={controlsId} className="filter-disclosure-controls" hidden={!open}>{children}</div>
    </section>
  );
}
