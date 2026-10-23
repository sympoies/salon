import { useLayoutEffect, useRef, type RefObject } from "react";

/**
 * Responsive drop order of a harness segment, shared by the desktop focused
 * session header and the session dropdown rows (#870).
 * When the row is too narrow, each stage hides one more item, first dropped
 * first:
 *
 *   1. quota meters (the quota percentages and reset times stay)
 *   2. the whole quota readout
 *   3. context tokens (`299k/1M`; the context percentage stays)
 *   4. reasoning effort
 *   5. model name
 *
 * The harness icon, account badge and title are never dropped; the title only
 * truncates, down to `minTitlePx`. Dropdown rows carry no quota, so their
 * first two stages change nothing. styles.css maps each stage to the hidden
 * items under `[data-harness-compact]`.
 */
export const HARNESS_COMPACT_STAGES = [0, 1, 2, 3, 4, 5] as const;
export type HarnessCompactStage = (typeof HARNESS_COMPACT_STAGES)[number];

export interface HarnessCompactTarget {
  /** The element whose direct children are the droppable items. */
  readonly target: HTMLElement;
  /** The row that must not overflow. */
  readonly row: HTMLElement;
  /** The title that must keep at least `minTitlePx` of width. */
  readonly title: HTMLElement | null;
  readonly minTitlePx: number;
}

/**
 * Apply the least compact stage that fits and return it. Self-contained, so a
 * browser layout test can run the same function against static markup.
 */
export function fitHarnessCompact({ target, row, title, minTitlePx }: HarnessCompactTarget): number {
  const stages = [0, 1, 2, 3, 4, 5];
  for (const stage of stages) {
    target.setAttribute("data-harness-compact", String(stage));
    const overflow = row.scrollWidth > row.clientWidth + 1;
    const titleWidth = title ? title.getBoundingClientRect().width : Infinity;
    if (!overflow && titleWidth >= minTitlePx) return stage;
  }
  return stages[stages.length - 1]!;
}

/** Keep `resolve()`'s targets fitted while the element is mounted and `active`. */
export function useHarnessCompact(
  rootRef: RefObject<HTMLElement | null>,
  active: boolean,
  resolve: (root: HTMLElement) => readonly HarnessCompactTarget[],
): void {
  const resolveRef = useRef(resolve);
  resolveRef.current = resolve;
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !active) return;
    let fitting = false;
    const update = () => {
      if (fitting) return;
      fitting = true;
      try {
        for (const target of resolveRef.current(root)) fitHarnessCompact(target);
      } finally {
        fitting = false;
      }
    };
    update();
    const ResizeObserverConstructor = window.ResizeObserver;
    const resize = typeof ResizeObserverConstructor === "function" ? new ResizeObserverConstructor(update) : null;
    resize?.observe(root);
    // Text such as a countdown or a retitle changes the space the title needs.
    const MutationObserverConstructor = window.MutationObserver;
    const mutations = typeof MutationObserverConstructor === "function" ? new MutationObserverConstructor(update) : null;
    mutations?.observe(root, { childList: true, subtree: true, characterData: true });
    window.addEventListener("resize", update);
    return () => {
      resize?.disconnect();
      mutations?.disconnect();
      window.removeEventListener("resize", update);
      for (const { target } of resolveRef.current(root)) target.removeAttribute("data-harness-compact");
    };
  }, [active, rootRef]);
}
