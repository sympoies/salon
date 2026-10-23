import { useCallback, useEffect, useId, useRef, useState } from "react";
import { IconButton } from "./IconButton.tsx";
import { AutoLayoutIcon, LayoutModeIcon } from "./LayoutIcons.tsx";
import { SelectChevronIcon } from "./icons.tsx";
import { LAYOUT_MODES, type LayoutMode } from "./layout.ts";
import { useDismissOnOutside } from "./useDismissOnOutside.ts";
import { useMenuFocus } from "./useMenuFocus.ts";

export interface LayoutPickerProps {
  readonly auto: boolean;
  readonly mode: LayoutMode;
  readonly displayedMode: LayoutMode;
  readonly onToggleAuto: () => void;
  readonly onSelect: (mode: LayoutMode) => void;
}

export function LayoutPicker({ auto, mode, displayedMode, onToggleAuto, onSelect }: LayoutPickerProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null), menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismissOnOutside(open, ".layout-picker", close);
  useEffect(() => {
    window.addEventListener("resize", close);
    return () => window.removeEventListener("resize", close);
  }, [close]);
  const focus = useMenuFocus({ open, menuRef, triggerRef, onClose: close, itemSelector: '[role="menuitemradio"]' });
  const label = (value: LayoutMode) => `${value} pane${value === 1 ? "" : "s"}`;
  const select = (value: LayoutMode) => { onSelect(value); close(); triggerRef.current?.focus(); };
  return <div className="layout-picker" role="group" aria-label="Terminal layout">
    <IconButton preset="standard" type="button" className={`layout-seg-btn is-auto ${auto ? "is-active" : ""}`}
      aria-pressed={auto} aria-label="Auto layout" title="Auto layout — grid follows the session count" onClick={onToggleAuto}>
      <AutoLayoutIcon />
    </IconButton>
    <div className="layout-seg layout-picker-inline">
      {LAYOUT_MODES.map(value => <IconButton preset="compact" key={value} type="button"
        className={`layout-seg-btn ${!auto && mode === value ? "is-active" : ""} ${auto ? "is-dimmed" : ""} ${auto && displayedMode === value ? "is-auto-current" : ""}`}
        aria-pressed={!auto && mode === value} aria-label={label(value)} title={label(value)} onClick={() => onSelect(value)}>
        <LayoutModeIcon mode={value} />
      </IconButton>)}
    </div>
    {/* The shared header button style, like More and New (#981). */}
    <IconButton ref={triggerRef} preset="standard" type="button" className="btn layout-picker-trigger"
      aria-label={`Choose layout, currently ${auto ? "Auto, " : ""}${label(auto ? displayedMode : mode)}`} title="Choose layout"
      aria-haspopup="menu" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
      <LayoutModeIcon mode={auto ? displayedMode : mode} /><SelectChevronIcon />
    </IconButton>
    {open ? <div ref={menuRef} id={id} className="layout-picker-menu" role="menu" aria-label="Choose terminal layout" onKeyDown={focus.onKeyDown}>
      {LAYOUT_MODES.map(value => <button key={value} type="button" role="menuitemradio" className="control-menu layout-picker-option"
        aria-checked={(auto ? displayedMode : mode) === value} onClick={() => select(value)}><LayoutModeIcon mode={value} />{label(value)}</button>)}
    </div> : null}
  </div>;
}
