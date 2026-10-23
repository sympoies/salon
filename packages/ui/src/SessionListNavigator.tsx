import { IconButton } from "./IconButton.tsx";
import { useCallback, useId, useRef, useState } from "react";
import { useDismissOnOutside } from "./useDismissOnOutside.ts";
import { useMenuFocus } from "./useMenuFocus.ts";
import { SessionFiltersBar, type SessionFiltersBarProps } from "./SessionFiltersBar.tsx";
export interface SessionListNavigatorProps extends SessionFiltersBarProps {
  readonly page: number;
  readonly pageCount: number;
  readonly onPageChange: (page: number) => void;
  /** The host-offline toast is centred on this pager and filter row. */
  readonly statusNotice?: import("react").ReactNode;
}
export function SessionListNavigator({ page: requestedPage, pageCount: rawPageCount, onPageChange, statusNotice, ...filters }: SessionListNavigatorProps) {
  // Desktop always shows the pager so its header row keeps one layout (no sessions reads 1 / 1);
  // a phone drops the pager row when there is only one page.
  const pageCount = Math.max(1, rawPageCount), page = Math.min(Math.max(1, requestedPage), pageCount), singlePage = pageCount <= 1;
  const showPager = !(filters.mobile && singlePage);
  const [pagePickerOpen, setPagePickerOpen] = useState(false);
  const pickerId = useId();
  const menuRef = useRef<HTMLDivElement>(null), triggerRef = useRef<HTMLButtonElement>(null);
  const closePicker = useCallback(() => setPagePickerOpen(false), []);
  useDismissOnOutside(pagePickerOpen, ".session-list-page-picker", closePicker);
  const menuFocus = useMenuFocus({ open: pagePickerOpen, menuRef, triggerRef, onClose: closePicker });
  return <div className="session-list-navigator"><SessionFiltersBar {...filters} compactHeader statusNotice={statusNotice}>
    {showPager ? <span className="session-list-pagination" role="group" aria-label={`Page ${page} of ${pageCount}`}>
      <IconButton preset="standard" className="session-list-page-button" type="button" aria-label="Previous page" disabled={singlePage} onClick={() => onPageChange(page - 1)}>‹</IconButton>
      <span className="session-list-page-picker">
        <button ref={triggerRef} id={`${pickerId}-trigger`} className="control-trigger session-list-page-label" type="button" aria-label={`Choose page, currently ${page} of ${pageCount}`}
          aria-haspopup="menu" aria-expanded={pagePickerOpen} aria-controls={pickerId} disabled={singlePage} onClick={() => setPagePickerOpen(value => !value)}>{page} / {pageCount}</button>
        {pagePickerOpen ? <div ref={menuRef} id={pickerId} className="session-list-page-menu" role="menu" aria-label="Choose page" onKeyDown={menuFocus.onKeyDown}>
          {Array.from({ length: pageCount }, (_, index) => index + 1).map(targetPage => <button key={targetPage} className="control-menu slot-menu-item session-list-page-menu-item" type="button" role="menuitem"
            aria-current={targetPage === page ? "true" : undefined} onClick={() => { onPageChange(targetPage); closePicker(); }}>Page {targetPage}</button>)}
        </div> : null}
      </span>
      <IconButton preset="standard" className="session-list-page-button" type="button" aria-label="Next page" disabled={singlePage} onClick={() => onPageChange(page + 1)}>›</IconButton>
    </span> : null}
  </SessionFiltersBar></div>;
}
