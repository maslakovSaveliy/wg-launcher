// Off-screen guard (architecture.md section 9) as a pure function over plain shapes. A later task
// maps Electron's displays and the `window_state` row to these shapes, and re-applies the saved
// maximized and fullscreen flags after creating the window at the returned bounds.

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DisplayArea {
  id: string;
  /** The display's work area: its bounds without the taskbar, dock and menu bar. */
  workArea: Bounds;
  primary: boolean;
}

/** The persisted position and size (`window_state`); x and y are null if never saved. */
export interface SavedWindow {
  x: number | null;
  y: number | null;
  width: number;
  height: number;
}

export const DEFAULT_WIDTH = 1280;
export const DEFAULT_HEIGHT = 800;
export const MIN_OVERLAP_WIDTH = 100;
export const MIN_OVERLAP_HEIGHT = 50;

const isFiniteNumber = (n: number | null): n is number => n !== null && Number.isFinite(n);

function overlaps(b: Bounds, area: Bounds): boolean {
  const w = Math.min(b.x + b.width, area.x + area.width) - Math.max(b.x, area.x);
  const h = Math.min(b.y + b.height, area.y + area.height) - Math.max(b.y, area.y);
  return w >= MIN_OVERLAP_WIDTH && h >= MIN_OVERLAP_HEIGHT;
}

function defaultBounds(displays: readonly DisplayArea[]): Bounds {
  const target = displays.find((d) => d.primary) ?? displays[0];
  if (!target) return { x: 0, y: 0, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
  const area = target.workArea;
  const width = Math.min(DEFAULT_WIDTH, area.width);
  const height = Math.min(DEFAULT_HEIGHT, area.height);
  return {
    x: area.x + Math.floor((area.width - width) / 2),
    y: area.y + Math.floor((area.height - height) / 2),
    width,
    height,
  };
}

/**
 * Saved bounds if they overlap the work area of one connected display by at least 100 by 50
 * pixels, else 1280 by 800 (clamped to a smaller work area) centered on the primary display.
 * Which display the window was on when saved does not matter: only the overlap does. A saved
 * position that is missing or not a finite number, and a non-positive size, count as unusable.
 */
export function restoreBounds(saved: SavedWindow | null, displays: readonly DisplayArea[]): Bounds {
  if (
    saved &&
    isFiniteNumber(saved.x) &&
    isFiniteNumber(saved.y) &&
    Number.isFinite(saved.width) &&
    Number.isFinite(saved.height) &&
    saved.width > 0 &&
    saved.height > 0
  ) {
    const bounds = { x: saved.x, y: saved.y, width: saved.width, height: saved.height };
    if (displays.some((d) => overlaps(bounds, d.workArea))) return bounds;
  }
  return defaultBounds(displays);
}
