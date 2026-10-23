import { IconButton } from "./IconButton.tsx";
import agentConsoleIconUrl from "./assets/agent-console-icon.svg";

export interface BrandTitleProps {
  readonly onMarkClick?: () => void;
  readonly markDisabled?: boolean;
  readonly markBusy?: boolean;
  readonly markTitle?: string;
}

export function BrandTitle({
  onMarkClick,
  markDisabled = false,
  markBusy = false,
  markTitle,
}: BrandTitleProps) {
  const mark = onMarkClick ? (
    <IconButton preset="identity"
      className="brand-title-mark brand-title-mark-button is-icon-busy"
      type="button"
      aria-busy={markBusy ? "true" : undefined}
      aria-label={markTitle ?? "Check and repair sessions"}
      title={markTitle ?? "Check and repair sessions"}
      disabled={markDisabled || markBusy}
      onClick={onMarkClick}
    >
      {markBusy ? <span className="btn-spinner" aria-hidden="true" /> : null}
      <img className="brand-title-icon" src={agentConsoleIconUrl} alt="" />
    </IconButton>
  ) : <BrandMark />;

  return (
    <div className="brand-title">
      {mark}
      <h1>Agent Console</h1>
    </div>
  );
}

/** The logo alone, as a decorative mark. */
export function BrandMark() {
  return (
    <span className="brand-title-mark" aria-hidden="true">
      <img className="brand-title-icon" src={agentConsoleIconUrl} alt="" />
    </span>
  );
}
