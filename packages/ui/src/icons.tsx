// Shared header/UI glyphs, inline so they inherit `currentColor` and need no
// external assets (same approach as LayoutIcons.tsx).

export function ZoomOutIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5M7.5 10.5h6" /></svg>;
}
export function ZoomInIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5M7.5 10.5h6M10.5 7.5v6" /></svg>;
}
export function FitImageIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5" /><rect x="7" y="7" width="10" height="10" rx="1" /></svg>;
}
export function DownloadIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" /></svg>;
}

export function ChevronLeftIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 6-6 6 6 6" /></svg>;
}
export function ChevronRightIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>;
}

// Settings cog — Feather "settings" outline.
export function GearIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="gear-icon"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

// Clock — the 5h rolling usage window. Outline, matches the gear style.
export function ClockIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="win-icon"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 1.8" />
    </svg>
  );
}

// Calendar — the weekly usage window.
export function CalendarIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="win-icon"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3.5" y="5" width="17" height="15.5" rx="2" />
      <path d="M3.5 9.5h17" />
      <path d="M8 3.5V6.5" />
      <path d="M16 3.5V6.5" />
    </svg>
  );
}

// Plus — the primary "new session" action. Outline, matches the gear style.
export function PlusIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="plus-icon"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

// Overflow "more" — three dots, the header menu trigger for the secondary pages.
export function MoreIcon() {
  return (
    <svg viewBox="0 0 24 24" className="more-icon" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="19" cy="12" r="1.7" />
    </svg>
  );
}

// Server stack — identifies the dashboard's machine-scoped session filter.
export function MachineIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="machine-filter-icon"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3.5" y="4" width="17" height="6" rx="1.8" />
      <rect x="3.5" y="14" width="17" height="6" rx="1.8" />
      <path d="M7.5 7h.01M7.5 17h.01M11 7h6M11 17h6" />
    </svg>
  );
}

// Dedicated select chevron so the control looks consistent across browsers.
// The class is a prop because the two disclosure controls position it
// differently: the machine filter overlays a native select, while the session
// group trigger lays it out inline.
export function SelectChevronIcon({ className = "machine-filter-chevron" }: { readonly className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m7.5 9.5 4.5 4.5 4.5-4.5" />
    </svg>
  );
}

// Open/maximize — enters the selected session from the list view.
export function OpenSessionIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="open-session-icon"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 3H3v5" />
      <path d="M3 3l7 7" />
      <path d="M16 21h5v-5" />
      <path d="M21 21l-7-7" />
    </svg>
  );
}

// Circular arrows — the auto-resume badge glyph. Outline, matches the gear
// style so the compact session-title badge reads as one family with the other
// header/slot icons.
export function AutoResumeIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="auto-resume-icon"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 12a8 8 0 0 1 13.7-5.6L20 8.5" />
      <path d="M20 4v4.5h-4.5" />
      <path d="M20 12a8 8 0 0 1-13.7 5.6L4 15.5" />
      <path d="M4 20v-4.5h4.5" />
    </svg>
  );
}

// Reload — rebuild this session's terminal. Deliberately a *single* arc with one
// head, against AutoResumeIcon's closed double ring: the two can sit side by side
// in a focused session's toolbar, and the auto-resume badge has already been read
// as a refresh control once.
export function RefreshIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="refresh-icon"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
      <path d="M19.8 4.6v4.2h-4.2" />
    </svg>
  );
}

// Pin — keeps the docked conversation on its session; fill conveys the pinned
// state without relying on color.
export function PinIcon({ filled = false }: { readonly filled?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="pin-icon"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 4h6l-1 5.2 3 3.3V14H7v-1.5l3-3.3z" />
      <path d="M12 14v6" />
    </svg>
  );
}

// Reply — a speech bubble with a return arrow; opens the conversation reply
// editor.
export function ReplyIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="reply-icon"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9.5 8 5 12.5 9.5 17" />
      <path d="M5 12.5h9a5 5 0 0 1 5 5V19" />
    </svg>
  );
}

// Close — the dismiss cross, drawn as SVG so it matches its icon neighbours.
export function CloseIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="close-icon"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6.5 6.5l11 11" />
      <path d="M17.5 6.5l-11 11" />
    </svg>
  );
}

// Trash — destructive session deletion affordance.
export function TrashIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="trash-icon"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M6 6l1 15h10l1-15" />
      <path d="M10 10v7" />
      <path d="M14 10v7" />
    </svg>
  );
}

// Star used for pinned History entries; fill conveys state without relying on color.
export function StarIcon({ filled = false }: { readonly filled?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="star-icon"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3.6l2.6 5.27 5.82.85-4.21 4.1.99 5.79L12 16.87l-5.2 2.74.99-5.79-4.21-4.1 5.82-.85z" />
    </svg>
  );
}


export function ConversationMicIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
    <rect x="9" y="2" width="6" height="13" rx="3" />
    <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" />
  </svg>;
}

export function ConversationSendIcon() {
  return <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M2.3 2.4a.8.8 0 0 0-1.1.9l3 7.1 10.5 1.6-10.5 1.6-3 7.1a.8.8 0 0 0 1.1.9l20-9a.7.7 0 0 0 0-1.2z" />
  </svg>;
}

export function ConversationAttachIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20.5 11.2l-8.3 8.3a5 5 0 0 1-7.1-7.1l8.3-8.3a3.3 3.3 0 0 1 4.7 4.7l-8.3 8.3a1.7 1.7 0 0 1-2.4-2.4l7.6-7.6" />
  </svg>;
}
