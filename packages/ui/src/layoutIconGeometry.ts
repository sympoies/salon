import type { LayoutMode } from "./layout.ts";

interface GridCell {
  readonly col: number;
  readonly row: number;
  readonly colSpan?: number;
  readonly rowSpan?: number;
}

interface ModeGrid {
  readonly cols: number;
  readonly rows: number;
  // Explicit placement for modes whose panes span tracks, listed in slot
  // (reading) order; otherwise one cell per track in row-major order.
  readonly cells?: readonly GridCell[];
}

// Grid shape each desktop layout mode renders, mirroring the CSS grid-templates
// (.session-workspace.desktop.mode-N): 1=1x1, 2=2 cols, 3=left half plus two
// stacked right panes, 4=2x2, 5=full-height left plus two stacks, 6=3x2.
const MODE_GRID: Record<LayoutMode, ModeGrid> = {
  1: { cols: 1, rows: 1 },
  2: { cols: 2, rows: 1 },
  3: { cols: 2, rows: 2, cells: [{ col: 0, row: 0, rowSpan: 2 }, { col: 1, row: 0 }, { col: 1, row: 1 }] },
  4: { cols: 2, rows: 2 },
  5: { cols: 3, rows: 2, cells: [
    { col: 0, row: 0, rowSpan: 2 },
    { col: 1, row: 0 }, { col: 2, row: 0 },
    { col: 1, row: 1 }, { col: 2, row: 1 },
  ] },
  6: { cols: 3, rows: 2 },
};

const ICON_VIEWBOX = 24;
const PAD = 3;
const GAP = 2;

export interface LayoutIconCell {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

function gridCells({ cols, rows, cells }: ModeGrid): readonly GridCell[] {
  if (cells) return cells;
  return Array.from({ length: cols * rows }, (_, i) => ({ col: i % cols, row: Math.floor(i / cols) }));
}

// Pure geometry: the cell rects an icon draws for a mode, laid out in a padded
// 24x24 box with gaps — so the icon is a faithful mini-diagram of the real grid.
export function layoutIconCells(mode: LayoutMode): LayoutIconCell[] {
  const grid = MODE_GRID[mode];
  const w = (ICON_VIEWBOX - PAD * 2 - GAP * (grid.cols - 1)) / grid.cols;
  const h = (ICON_VIEWBOX - PAD * 2 - GAP * (grid.rows - 1)) / grid.rows;
  const round = (n: number) => Number(n.toFixed(2));
  return gridCells(grid).map(({ col, row, colSpan = 1, rowSpan = 1 }) => ({
    x: round(PAD + col * (w + GAP)),
    y: round(PAD + row * (h + GAP)),
    w: round(w * colSpan + GAP * (colSpan - 1)),
    h: round(h * rowSpan + GAP * (rowSpan - 1)),
  }));
}
