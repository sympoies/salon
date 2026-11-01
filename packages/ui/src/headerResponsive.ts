export const HEADER_COMPACT_STAGES = [0, 1, 2, 3, 4, 5] as const;
export type HeaderCompactStage = (typeof HEADER_COMPACT_STAGES)[number];

/** Return the least compact stage that fits, or the fully collapsed stage. */
export function chooseHeaderCompactStage(fits: (stage: HeaderCompactStage) => boolean): HeaderCompactStage {
  return HEADER_COMPACT_STAGES.find(fits) ?? 5;
}

/**
 * Measure the same controls that CSS compacts, including headers without Usage.
 * The phone layout (Dashboard's single-column tier: up to 760px, or a touch
 * pointer up to 1024px, or the Android app) keeps the two-row header without the layout picker;
 * its status counts take the longest label that fits: full, short, then none
 * (#968). Narrow macOS windows keep the measured desktop row (title-bar counts).
 */
export function updateHeaderCompaction(header: HTMLElement): HeaderCompactStage | null {
  // The tier published by syncPhoneTier, the same one the phone header rules in styles.css use.
  if (document.documentElement.dataset.phoneTier === "true"
    && document.documentElement.dataset.macTitlebar !== "true") {
    header.removeAttribute("data-header-compact");
    // Count buttons shrink and clip before they overlap, so both are checked.
    const labelsFit = () => {
      const buttons = [...header.querySelectorAll<HTMLElement>(".session-status-count")];
      if (!buttons.length) return true;
      const rects = buttons.map(button => button.getBoundingClientRect());
      const left = Math.min(...rects.map(rect => rect.left)), right = Math.max(...rects.map(rect => rect.right));
      const top = Math.min(...rects.map(rect => rect.top)), bottom = Math.max(...rects.map(rect => rect.bottom));
      const bounds = header.getBoundingClientRect();
      return left >= bounds.left - 1 && right <= bounds.right + 1
        && buttons.every(button => button.scrollWidth <= button.clientWidth + 1)
        && [...header.querySelectorAll<HTMLElement>(".brand-title-mark,.header-menu-trigger,.dashboard-new-session")].every(control => {
          const rect = control.getBoundingClientRect();
          return !rect.width || rect.bottom <= top || rect.top >= bottom || rect.right <= left + 1 || rect.left >= right - 1;
        });
    };
    header.dataset.countLabels = (["full", "short", "none"] as const).find(form => {
      header.dataset.countLabels = form;
      return labelsFit();
    }) ?? "none";
    return null;
  }
  header.removeAttribute("data-count-labels");
  const stage = chooseHeaderCompactStage(value => {
    header.dataset.headerCompact = String(value);
    const bounds = header.getBoundingClientRect();
    const controls = header.querySelectorAll<HTMLElement>(
      ".brand-title,.session-status-count,.session-list-pagination,.session-filter-searchbar,.header-usage,.layout-picker,.header-menu-trigger,.dashboard-new-session,.machine-filter,.connection-notice-layer.is-inline",
    );
    const inside = [...controls].every(control => {
      const rect = control.getBoundingClientRect();
      // An open menu, such as the page picker's (#952), overflows its control
      // by design; only the control's own box must fit.
      const menuOpen = control.querySelector('[role="menu"]') !== null;
      return !rect.width || (rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1
        && (menuOpen || control.scrollWidth <= control.clientWidth + 1));
    });
    // On the centered desktop row (761px and up) the filter field keeps its
    // dropdown panel's width until stage 3, then shrinks before Usage is hidden.
    // Narrow macOS windows keep the #915 row and its original fit rule.
    const centeredRow = window.matchMedia("(min-width: 761px)").matches;
    const filter = header.querySelector<HTMLElement>(".session-filters-summary.is-compact-header .session-filter-trigger-row");
    const panelWidth = parseFloat(window.getComputedStyle(header).getPropertyValue("--session-filter-panel-width"));
    if (centeredRow && value < 3 && filter && panelWidth && filter.getBoundingClientRect().width < panelWidth - 1) return false;
    // Usage is centered on the row, so it must also clear every other control.
    const usage = header.querySelector<HTMLElement>(".header-usage")?.getBoundingClientRect();
    return inside && (!centeredRow || !usage?.width || [...controls].every(control => {
      if (control.classList.contains("header-usage")) return true;
      const rect = control.getBoundingClientRect();
      return !rect.width || rect.right + 8 <= usage.left || rect.left >= usage.right + 8;
    }));
  });
  header.dataset.headerCompact = String(stage);
  return stage;
}
