import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { useAndroidBackEntry } from "./useAndroidBackEntry.ts";
import { useAnchoredFloating } from "./useAnchoredFloating.ts";

export interface SelectMenuOption {
  readonly value: string;
  readonly label: string;
  readonly meta?: string;
  /** Shown but not selectable, like a disabled native option. */
  readonly disabled?: boolean;
  /**
   * Decorative leading mark (an agent badge, a machine dot). Rendered
   * aria-hidden inside a fixed-size slot, so pass presentation only — the
   * accessible name still comes from `label`/`meta`.
   */
  readonly icon?: ReactNode;
}

export interface SelectMenuProps {
  readonly ariaLabel: string;
  readonly value: string;
  readonly options: readonly SelectMenuOption[];
  readonly disabled?: boolean;
  /** Extra class on the root, for a caller that sizes or positions the control. */
  readonly className?: string;
  readonly onChange: (value: string) => void;
}

interface SelectMenuGroupValue {
  readonly activeId: string | null;
  readonly activate: (id: string, onBack: () => void) => void;
  readonly deactivate: (id: string) => void;
  readonly preparePointerSwitch: () => void;
  readonly pointerSwitchPrepared: () => boolean;
}

const SelectMenuGroupContext = createContext<SelectMenuGroupValue | null>(null);

export function SelectMenuGroup({ children }: { readonly children: ReactNode }) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const groupId = useId();
  const activeBackRef = useRef<(() => void) | null>(null);
  const pointerSwitchRef = useRef(false);
  const pointerSwitchTimerRef = useRef<number | null>(null);
  const clearPointerSwitch = useCallback(() => {
    pointerSwitchRef.current = false;
    if (pointerSwitchTimerRef.current !== null) {
      window.clearTimeout(pointerSwitchTimerRef.current);
      pointerSwitchTimerRef.current = null;
    }
  }, []);
  const preparePointerSwitch = useCallback(() => {
    clearPointerSwitch();
    pointerSwitchRef.current = true;
    pointerSwitchTimerRef.current = window.setTimeout(() => {
      pointerSwitchRef.current = false;
      pointerSwitchTimerRef.current = null;
    }, 0);
  }, [clearPointerSwitch]);
  const pointerSwitchPrepared = useCallback(() => pointerSwitchRef.current, []);
  const activate = useCallback((id: string, onBack: () => void) => {
    clearPointerSwitch();
    activeBackRef.current = onBack;
    setActiveId(id);
  }, [clearPointerSwitch]);
  const deactivate = useCallback((id: string) => {
    clearPointerSwitch();
    setActiveId((current) => current === id ? null : current);
  }, [clearPointerSwitch]);

  useEffect(() => clearPointerSwitch, [clearPointerSwitch]);

  useAndroidBackEntry(`select-menu-group-${groupId}`, activeId !== null, () => activeBackRef.current?.());

  const value = useMemo(
    () => ({ activeId, activate, deactivate, preparePointerSwitch, pointerSwitchPrepared }),
    [activeId, activate, deactivate, pointerSwitchPrepared, preparePointerSwitch],
  );
  return <SelectMenuGroupContext.Provider value={value}>{children}</SelectMenuGroupContext.Provider>;
}

function optionAccessibleName(option: SelectMenuOption | undefined): string {
  if (!option) {
    return "No selection";
  }
  return option.meta ? `${option.label}, ${option.meta}` : option.label;
}

function triggerNavigationIndex(key: string, selectedIndex: number, optionCount: number): number {
  if (key === "Home") return 0;
  if (key === "End") return optionCount - 1;
  if (key === "ArrowDown") return (selectedIndex + 1) % optionCount;
  return (selectedIndex - 1 + optionCount) % optionCount;
}

export function SelectMenu({ ariaLabel, value, options, disabled = false, className, onChange }: SelectMenuProps) {
  const group = useContext(SelectMenuGroupContext);
  const [localOpen, setLocalOpen] = useState(false);
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  const initialFocusIndexRef = useRef<number | null>(null);
  const selectedIndex = Math.max(options.findIndex((option) => option.value === value), 0);
  const selectedOption = options[selectedIndex];
  // A single marked option reserves the slot for the whole menu, so labels keep
  // one text baseline whether or not every entry carries a mark — and so two
  // stacked selects agree once both opt in.
  const hasMarks = options.some((option) => option.icon !== undefined);
  const open = group ? group.activeId === listboxId : localOpen;
  const { style: floatingStyle } = useAnchoredFloating(triggerRef, open, { maxHeight: 260 });

  const focusOption = (index: number) => {
    const items = listboxRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]');
    const target = items?.item(index);
    (target && !target.disabled ? target : listboxRef.current?.querySelector<HTMLButtonElement>('[role="option"]:not(:disabled)'))?.focus();
  };

  function setMenuOpen(next: boolean) {
    if (group) {
      if (next) {
        group.activate(listboxId, () => close(true));
      } else {
        group.deactivate(listboxId);
      }
    } else {
      setLocalOpen(next);
    }
  }

  function close(restoreFocus: boolean) {
    setMenuOpen(false);
    if (restoreFocus) {
      triggerRef.current?.focus();
    }
  }

  useAndroidBackEntry(`select-menu-${listboxId}`, group === null && open, () => close(true));

  useEffect(() => {
    if (!group) {
      return;
    }
    return () => group.deactivate(listboxId);
  }, [group?.deactivate, listboxId]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const closeOnPointer = (event: PointerEvent) => {
      const target = event.target;
      const preservesGroupedSwitch = group
        && group.pointerSwitchPrepared()
        && target instanceof Element
        && target.closest(".select-menu");
      if (target && !rootRef.current?.contains(target as Node) && !preservesGroupedSwitch) {
        close(false);
      }
    };
    document.addEventListener("pointerdown", closeOnPointer);
    return () => document.removeEventListener("pointerdown", closeOnPointer);
  }, [group, open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    if (disabled || options.length === 0) {
      close(false);
      return;
    }
    const timer = window.setTimeout(() => {
      const focusIndex = initialFocusIndexRef.current ?? selectedIndex;
      initialFocusIndexRef.current = null;
      focusOption(focusIndex);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [disabled, open, options.length, selectedIndex]);

  const choose = (option: SelectMenuOption) => {
    if (option.value !== value) {
      onChange(option.value);
    }
    close(true);
  };

  const onListboxKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = [...(listboxRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ?? [])];
    const currentIndex = document.activeElement instanceof HTMLElement
      ? items.indexOf(document.activeElement as HTMLButtonElement)
      : -1;
    const focusAt = (index: number) => {
      event.preventDefault();
      event.stopPropagation();
      items.at(index)?.focus();
    };

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "ArrowDown") {
      focusAt(currentIndex >= 0 ? (currentIndex + 1) % items.length : 0);
    } else if (event.key === "ArrowUp") {
      focusAt(currentIndex >= 0 ? (currentIndex - 1 + items.length) % items.length : items.length - 1);
    } else if (event.key === "Home") {
      focusAt(0);
    } else if (event.key === "End") {
      focusAt(items.length - 1);
    } else if ((event.key === "Enter" || event.key === " ") && currentIndex >= 0) {
      event.preventDefault();
      event.stopPropagation();
      items[currentIndex]?.click();
    }
  };

  return (
    <div
      ref={rootRef}
      className={className ? `select-menu ${className}` : "select-menu"}
      onBlur={(event) => {
        const preservesGroupedSwitch = group
          && group.pointerSwitchPrepared()
          && event.relatedTarget instanceof Element
          && event.relatedTarget.closest(".select-menu");
        if (!event.currentTarget.contains(event.relatedTarget) && !preservesGroupedSwitch) {
          close(false);
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="select-menu-trigger"
        role="combobox"
        aria-label={`${ariaLabel}: ${optionAccessibleName(selectedOption)}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        disabled={disabled || options.length === 0}
        onPointerDown={() => group?.preparePointerSwitch()}
        onClick={() => setMenuOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
            event.preventDefault();
            event.stopPropagation();
            const focusIndex = triggerNavigationIndex(event.key, selectedIndex, options.length);
            if (open) {
              focusOption(focusIndex);
            } else {
              initialFocusIndexRef.current = focusIndex;
              setMenuOpen(true);
            }
          } else if (event.key === "Escape" && open) {
            event.preventDefault();
            event.stopPropagation();
            close(false);
          }
        }}
      >
        {hasMarks ? (
          <span className="select-menu-icon" aria-hidden="true">{selectedOption?.icon}</span>
        ) : null}
        <span className="select-menu-value">{selectedOption?.label ?? ""}</span>
        {selectedOption?.meta ? <span className="select-menu-value-meta">{selectedOption.meta}</span> : null}
      </button>
      {open ? (
        <>
          <div
            className="select-menu-scrim"
            aria-hidden="true"
            onPointerDown={(event) => {
              event.preventDefault();
              close(true);
            }}
          />
          <div
            ref={listboxRef}
            id={listboxId}
            className="select-menu-options"
            style={floatingStyle}
            role="listbox"
            aria-label={`${ariaLabel} options`}
            onKeyDown={onListboxKeyDown}
          >
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                className="select-menu-option"
                role="option"
                aria-label={optionAccessibleName(option)}
                aria-selected={option.value === value}
                disabled={option.disabled}
                tabIndex={-1}
                onClick={() => choose(option)}
              >
                {hasMarks ? (
                  <span className="select-menu-icon" aria-hidden="true">{option.icon}</span>
                ) : null}
                <span className="select-menu-option-label">{option.label}</span>
                {option.meta ? <span className="select-menu-option-meta">{option.meta}</span> : null}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
