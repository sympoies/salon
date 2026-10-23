import type { CardStatus } from "./sessionActivity.ts";

export function CardStatusIcon({state, dot = false}: {readonly state: CardStatus; readonly dot?: boolean}) {
  const icons = {
    working: <circle cx="12" cy="12" r="6" fill="currentColor" />,
    waiting: <circle cx="12" cy="12" r="7" />,
    completed: <path d="m5 12 5 5L20 7" />,
    blocked: <><path d="m12 3 10 18H2ZM12 9v5" /><circle cx="12" cy="17" r=".8" fill="currentColor" /></>,
    stopped: <circle cx="12" cy="12" r="6" fill="currentColor" />,
    // Unobservable, not a request: a hollow dashed ring, never the warning color (#873).
    unknown: <circle cx="12" cy="12" r="7" strokeDasharray="3 3" />,
  };
  return (
    <svg className="card-status-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{dot ? <circle cx="12" cy="12" r="6" fill="currentColor" /> : icons[state]}</svg>
  );
}
