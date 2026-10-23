import { useCallback, useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";

export interface AnchoredFloatingOptions {
  /** Gap in px kept between the trigger and the floating panel. */
  readonly gap?: number;
  /** Max panel height in px; also clamped down to the space actually available. */
  readonly maxHeight?: number;
  /** Minimum margin in px kept between the panel and the viewport edges. */
  readonly margin?: number;
}

export interface AnchoredFloatingResult {
  /** Inline style to spread onto the floating panel element. */
  readonly style: CSSProperties;
}

/** A trigger rectangle in layout-viewport coordinates (as `getBoundingClientRect`). */
export interface AnchorRect {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly width: number;
}

/** Layout-viewport size (as `window.innerWidth` / `innerHeight`). */
export interface AnchorViewport {
  readonly width: number;
  readonly height: number;
}

const HIDDEN_STYLE: CSSProperties = { position: "fixed", visibility: "hidden", top: 0, left: 0 };

/**
 * Pure geometry for the anchored popover: given the trigger rect and the
 * viewport, return the fixed-position inline style.
 *
 * Everything is expressed in one coordinate system — the layout viewport, which
 * is what both `getBoundingClientRect` and a `position: fixed` element use. On
 * Android/Chromium (the APK target) the layout viewport shrinks when the
 * on-screen keyboard opens, so anchoring stays above the keyboard without any
 * `visualViewport` offset math. The panel is placed below the trigger by
 * default and flipped above only when the space below is too small and there is
 * more room above; its height is clamped to the available space, and its left
 * edge is kept inside the viewport margins.
 */
export function computeAnchoredStyle(
  rect: AnchorRect,
  viewport: AnchorViewport,
  { gap = 4, maxHeight = 320, margin = 8 }: AnchoredFloatingOptions = {},
): CSSProperties {
  const spaceBelow = viewport.height - rect.bottom - margin;
  const spaceAbove = rect.top - margin;
  const flipUp = spaceBelow < Math.min(maxHeight, 160) && spaceAbove > spaceBelow;
  const available = Math.max(flipUp ? spaceAbove : spaceBelow, 0);
  const height = Math.round(Math.min(maxHeight, available));
  const left = Math.round(
    Math.min(Math.max(rect.left, margin), Math.max(viewport.width - margin - rect.width, margin)),
  );
  const base: CSSProperties = { position: "fixed", left, width: Math.round(rect.width), maxHeight: height };
  return flipUp
    ? { ...base, bottom: Math.round(viewport.height - rect.top + gap) }
    : { ...base, top: Math.round(rect.bottom + gap) };
}

function sameStyle(a: CSSProperties, b: CSSProperties): boolean {
  return a.position === b.position
    && a.left === b.left
    && a.width === b.width
    && a.maxHeight === b.maxHeight
    && a.top === b.top
    && a.bottom === b.bottom
    && a.visibility === b.visibility;
}

/**
 * Positions a floating listbox anchored to a trigger element.
 *
 * Both the New-session select menus and the repo picker live inside a modal
 * whose body scrolls (`overflow: auto`), so an `absolute` dropdown would be
 * clipped by the modal and pinned below its field. This hook renders the panel
 * with `position: fixed` — escaping the modal's clip — anchored under (or
 * flipped above) the trigger via {@link computeAnchoredStyle}, and recomputes on
 * scroll / resize / on-screen-keyboard changes.
 *
 * INVARIANT: `position: fixed` resolves against the viewport only while no
 * ancestor of the trigger establishes a containing block (a `transform`,
 * `filter`, `perspective`, `will-change`, or `contain`). Do not add such a
 * property to a persistent ancestor of a popover trigger (e.g. `.modal`), or the
 * panel will anchor to that ancestor and be re-clipped. The transient
 * `.modal--attention` shake is safe because an open popover dismisses on the
 * same outside pointer-down that triggers the shake, so the two never overlap.
 *
 * Recomputes coalesce to one layout read per animation frame, and the state
 * update bails out when the geometry is unchanged, so the event burst the
 * on-screen keyboard produces does not re-render the consumer subtree per event.
 *
 * In non-layout environments (SSR / test DOM) `getBoundingClientRect` returns
 * zeros; the panel still gets `position: fixed` and renders at the origin.
 */
export function useAnchoredFloating(
  triggerRef: RefObject<HTMLElement | null>,
  open: boolean,
  options: AnchoredFloatingOptions = {},
): AnchoredFloatingResult {
  const { gap, maxHeight, margin } = options;
  const [style, setStyle] = useState<CSSProperties>(HIDDEN_STYLE);

  const compute = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) {
      return;
    }
    const rect = trigger.getBoundingClientRect();
    const next = computeAnchoredStyle(
      rect,
      { width: window.innerWidth, height: window.innerHeight },
      { gap, maxHeight, margin },
    );
    setStyle((current) => (sameStyle(current, next) ? current : next));
  }, [gap, margin, maxHeight, triggerRef]);

  useLayoutEffect(() => {
    if (!open) {
      setStyle((current) => (current === HIDDEN_STYLE ? current : HIDDEN_STYLE));
      return;
    }
    compute();
    let frame = 0;
    // Coalesce a burst of events (keyboard slide, momentum scroll) into one
    // layout read per frame.
    const onChange = () => {
      if (frame !== 0) {
        return;
      }
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        compute();
      });
    };
    // Capture phase catches scrolls inside the modal body, not just the window.
    window.addEventListener("scroll", onChange, true);
    window.addEventListener("resize", onChange);
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", onChange);
    viewport?.addEventListener("scroll", onChange);
    return () => {
      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
      }
      window.removeEventListener("scroll", onChange, true);
      window.removeEventListener("resize", onChange);
      viewport?.removeEventListener("resize", onChange);
      viewport?.removeEventListener("scroll", onChange);
    };
  }, [open, compute]);

  return { style };
}
