import {
  useEffect,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";

const MENU_ITEM_SELECTOR = '[role="menuitem"]:not([disabled]), [role="menuitemcheckbox"]:not([disabled])';

export interface UseMenuFocusOptions {
  readonly open: boolean;
  readonly menuRef: RefObject<HTMLElement | null>;
  readonly triggerRef: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  readonly itemSelector?: string;
}

function focusableMenuItems(menu: HTMLElement | null, itemSelector: string): HTMLElement[] {
  if (!menu) {
    return [];
  }
  return Array.from(menu.querySelectorAll<HTMLElement>(itemSelector)).filter((item) => {
    if (item.getAttribute("aria-disabled") === "true" || item.hidden) {
      return false;
    }
    const style = window.getComputedStyle(item);
    return style.display !== "none" && style.visibility !== "hidden";
  });
}

function focusMenuItem(menu: HTMLElement | null, itemSelector: string, index: number): void {
  const items = focusableMenuItems(menu, itemSelector);
  items.at(index)?.focus();
}

export function useMenuFocus({
  open,
  menuRef,
  triggerRef,
  onClose,
  itemSelector = MENU_ITEM_SELECTOR,
}: UseMenuFocusOptions): { readonly onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void } {
  useEffect(() => {
    if (!open) {
      return;
    }
    const timer = window.setTimeout(() => {
      if (menuRef.current?.contains(document.activeElement)) {
        return;
      }
      focusMenuItem(menuRef.current, itemSelector, 0);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [itemSelector, menuRef, open]);

  return {
    onKeyDown(event) {
      const items = focusableMenuItems(menuRef.current, itemSelector);
      if (items.length === 0) {
        return;
      }
      const currentIndex = document.activeElement instanceof HTMLElement ? items.indexOf(document.activeElement) : -1;
      const focusAt = (index: number) => {
        event.preventDefault();
        event.stopPropagation();
        items.at(index)?.focus();
      };

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        triggerRef.current?.focus();
        return;
      }
      if (event.key === "ArrowDown") {
        focusAt(currentIndex >= 0 ? (currentIndex + 1) % items.length : 0);
        return;
      }
      if (event.key === "ArrowUp") {
        focusAt(currentIndex >= 0 ? (currentIndex - 1 + items.length) % items.length : items.length - 1);
        return;
      }
      if (event.key === "Home") {
        focusAt(0);
        return;
      }
      if (event.key === "End") {
        focusAt(items.length - 1);
      }
    },
  };
}
