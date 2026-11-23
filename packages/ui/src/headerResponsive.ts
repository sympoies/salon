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
 * its status counts keep a fixed dot-and-number form. Narrow macOS windows keep
 * the measured desktop row (title-bar counts).
 */
export function updateHeaderCompaction(header: HTMLElement): HeaderCompactStage | null {
  // Give quota the room left by the logo, New, More and number-only counts:
  // fewer complete accounts, then progressively less detail for one account.
  const fitQuota = (): void => {
    const usage = header.querySelector<HTMLElement>(".header-usage");
    if (!usage) return;
    const total = usage.querySelectorAll(".hu-provider").length;
    const compactDetails = ["compact", "window-meter", "window-percent", "percent"] as const;
    const steps: Array<readonly [number, "full" | (typeof compactDetails)[number]]> = [];
    for (let accounts = total; accounts >= 1; accounts--) steps.push([accounts, "full"]);
    if (total > 0) {
      for (const detail of compactDetails) steps.push([1, detail]);
    }
    const fits = () => {
      const rect = usage.getBoundingClientRect();
      const bounds = header.getBoundingClientRect();
      // Phone entries keep their intrinsic widths. Any excess now overflows
      // the strip instead of being absorbed by an account name or meter.
      return rect.width > 0 && usage.scrollWidth <= usage.clientWidth && usage.scrollHeight <= usage.clientHeight
        && rect.left >= bounds.left && rect.right <= bounds.right;
    };
    for (const [accounts, detail] of steps) {
      header.dataset.quotaAccounts = String(accounts);
      header.dataset.quotaDetail = detail;
      if (fits()) return;
    }
    header.dataset.quotaAccounts = "0";
    header.dataset.quotaDetail = "compact";
  };
  // The tier published by syncPhoneTier, the same one the phone header rules in styles.css use.
  if (document.documentElement.dataset.phoneHeader === "true"
    && document.documentElement.dataset.macTitlebar !== "true") {
    header.removeAttribute("data-header-compact");
    fitQuota();
    return null;
  }
  header.removeAttribute("data-quota-accounts");
  header.removeAttribute("data-quota-detail");
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
