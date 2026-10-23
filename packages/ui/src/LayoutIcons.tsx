import type { LayoutMode } from "./layout.ts";
import { layoutIconCells } from "./layoutIconGeometry.ts";

export function LayoutModeIcon({ mode }: { readonly mode: LayoutMode }) {
  return (
    <svg viewBox="0 0 24 24" className="layout-icon" fill="currentColor" aria-hidden="true" focusable="false">
      {layoutIconCells(mode).map((cell, i) => (
        <rect key={i} x={cell.x} y={cell.y} width={cell.w} height={cell.h} rx="1.6" />
      ))}
    </svg>
  );
}

// "Auto" is icon-only: a sparkle (the common auto/adaptive glyph), sized to match
// the grid icons so the whole segmented control reads as one row.
export function AutoLayoutIcon() {
  return (
    <svg viewBox="0 0 24 24" className="layout-icon" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M10.5 3 L12.62 8.38 L18 10.5 L12.62 12.62 L10.5 18 L8.38 12.62 L3 10.5 L8.38 8.38 Z" />
      <path d="M18 14.8 L18.92 17.08 L21.2 18 L18.92 18.92 L18 21.2 L17.08 18.92 L14.8 18 L17.08 17.08 Z" />
    </svg>
  );
}
