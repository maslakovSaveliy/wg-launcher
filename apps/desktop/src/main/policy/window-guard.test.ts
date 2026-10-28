import { describe, expect, it } from "vitest";
import { type DisplayArea, restoreBounds } from "./window-guard.js";

// architecture.md section 9: saved bounds are used only if they overlap the work area of a
// connected display by at least 100 by 50 pixels; otherwise 1280 by 800 centered on the primary.

const primary: DisplayArea = {
  id: "d1",
  primary: true,
  workArea: { x: 0, y: 25, width: 1920, height: 1055 },
};
const right: DisplayArea = {
  id: "d2",
  primary: false,
  workArea: { x: 1920, y: 0, width: 1280, height: 1024 },
};
const left: DisplayArea = {
  id: "d3",
  primary: false,
  workArea: { x: -1600, y: -100, width: 1600, height: 900 },
};

// Centered 1280 x 800 on the primary work area above.
const defaultOnPrimary = { x: 320, y: 25 + 127, width: 1280, height: 800 };

const win = (x: number | null, y: number | null, width = 800, height = 600) => ({
  x,
  y,
  width,
  height,
});

describe("restoreBounds", () => {
  it("uses the default centered on the primary display when nothing is saved", () => {
    expect(restoreBounds(null, [primary, right])).toEqual(defaultOnPrimary);
  });

  it("returns saved bounds that are fully inside a display, unchanged", () => {
    expect(restoreBounds(win(100, 100), [primary])).toEqual({
      x: 100,
      y: 100,
      width: 800,
      height: 600,
    });
  });

  it("uses a window on a secondary display", () => {
    expect(restoreBounds(win(2000, 50), [primary, right])).toEqual({
      x: 2000,
      y: 50,
      width: 800,
      height: 600,
    });
  });

  it("uses negative coordinates on a display to the left", () => {
    expect(restoreBounds(win(-1500, -50, 700, 500), [primary, left])).toEqual({
      x: -1500,
      y: -50,
      width: 700,
      height: 500,
    });
  });

  it("falls back to the default when the display it was on has been removed", () => {
    expect(restoreBounds(win(2000, 50), [primary])).toEqual(defaultOnPrimary);
    expect(restoreBounds(win(-1500, -50, 700, 500), [primary])).toEqual(defaultOnPrimary);
  });

  it("uses the overlap with any display, so a saved display id is only a hint", () => {
    // Saved on the right display, which is gone; the same coordinates still overlap the primary
    // when the layout changed.
    const moved: DisplayArea = {
      ...primary,
      workArea: { x: 1500, y: 0, width: 1920, height: 1080 },
    };
    expect(restoreBounds(win(2000, 50), [moved])).toEqual({
      x: 2000,
      y: 50,
      width: 800,
      height: 600,
    });
  });

  describe("partly visible windows (100 by 50 threshold)", () => {
    it("is kept at exactly 100 by 50 overlap on the right edge", () => {
      // Window starts 100 px before the right edge of the only display.
      expect(restoreBounds(win(1820, 500), [primary]).x).toBe(1820);
    });

    it("is replaced at 99 px of horizontal overlap", () => {
      expect(restoreBounds(win(1821, 500), [primary])).toEqual(defaultOnPrimary);
    });

    it("is kept at exactly 50 px of vertical overlap on the bottom edge", () => {
      // Work area bottom is 25 + 1055 = 1080.
      expect(restoreBounds(win(100, 1030), [primary]).y).toBe(1030);
    });

    it("is replaced at 49 px of vertical overlap on the bottom edge", () => {
      expect(restoreBounds(win(100, 1031), [primary])).toEqual(defaultOnPrimary);
    });

    it("is kept at exactly 50 px of vertical overlap above the top edge", () => {
      // Window of height 600 whose last 50 px are inside the work area (top at 25).
      expect(restoreBounds(win(100, -525), [primary]).y).toBe(-525);
    });

    it("is replaced at 49 px of vertical overlap above the top edge", () => {
      expect(restoreBounds(win(100, -526), [primary])).toEqual(defaultOnPrimary);
    });

    it("is kept at exactly 100 px of overlap past the left edge", () => {
      expect(restoreBounds(win(-700, 300), [primary]).x).toBe(-700);
    });

    it("is replaced at 99 px of overlap past the left edge", () => {
      expect(restoreBounds(win(-701, 300), [primary])).toEqual(defaultOnPrimary);
    });

    it("needs both overlaps on one display, not 100 wide here and 50 tall there", () => {
      // 100+ px of width overlap with the primary (but above it) and tall overlap with another
      // display only at a corner: neither display alone has 100 by 50.
      const a: DisplayArea = {
        id: "a",
        primary: true,
        workArea: { x: 0, y: 0, width: 1000, height: 1000 },
      };
      const b: DisplayArea = {
        id: "b",
        primary: false,
        workArea: { x: 1000, y: 0, width: 1000, height: 1000 },
      };
      // Window 200 x 200 at x 950: 50 px on a, 150 px on b -> b has 150 by 200: kept.
      expect(restoreBounds(win(950, 100, 200, 200), [a, b]).x).toBe(950);
      // Window 150 x 200 at x 920: 80 px on a and 70 px on b: no single display reaches 100.
      expect(restoreBounds(win(920, 100, 150, 200), [a, b])).toEqual({
        x: 0,
        y: 100,
        width: 1000,
        height: 800,
      });
    });
  });

  describe("a saved size without a position (Ruling R21, PRD F-7)", () => {
    // 800 x 600 centered on the primary work area { x: 0, y: 25, width: 1920, height: 1055 }.
    const savedSizeOnPrimary = { x: 560, y: 25 + 227, width: 800, height: 600 };

    it("keeps the saved size, centered on the primary display, when the position was never saved", () => {
      expect(restoreBounds(win(null, null), [primary])).toEqual(savedSizeOnPrimary);
      expect(restoreBounds(win(100, null), [primary])).toEqual(savedSizeOnPrimary);
      expect(restoreBounds(win(null, 100), [right, primary])).toEqual(savedSizeOnPrimary);
    });

    it("treats a position that is not a finite number as missing", () => {
      expect(restoreBounds(win(Number.NaN, 100), [primary])).toEqual(savedSizeOnPrimary);
      expect(restoreBounds(win(100, Number.NEGATIVE_INFINITY), [primary])).toEqual(
        savedSizeOnPrimary,
      );
    });

    it("clamps the saved size to the primary work area", () => {
      const small: DisplayArea = {
        id: "s",
        primary: true,
        workArea: { x: 10, y: 20, width: 1024, height: 700 },
      };
      expect(restoreBounds(win(null, null, 3000, 500), [small])).toEqual({
        x: 10,
        y: 120,
        width: 1024,
        height: 500,
      });
      expect(restoreBounds(win(null, null, 2000, 2000), [small])).toEqual({
        x: 10,
        y: 20,
        width: 1024,
        height: 700,
      });
    });

    it("keeps the saved size when no display is connected", () => {
      expect(restoreBounds(win(null, null), [])).toEqual({ x: 0, y: 0, width: 800, height: 600 });
    });
  });

  describe("unusable saved values", () => {
    it("uses the default for a non-finite or non-positive size", () => {
      expect(restoreBounds(win(100, 100, 0, 600), [primary])).toEqual(defaultOnPrimary);
      expect(restoreBounds(win(100, 100, 800, -5), [primary])).toEqual(defaultOnPrimary);
      expect(restoreBounds(win(null, null, 800, 0), [primary])).toEqual(defaultOnPrimary);
      expect(restoreBounds(win(100, 100, Number.POSITIVE_INFINITY, 600), [primary])).toEqual(
        defaultOnPrimary,
      );
      expect(restoreBounds(win(null, null, Number.NaN, 600), [primary])).toEqual(defaultOnPrimary);
    });

    it("uses the default size for a saved position that is off every display", () => {
      expect(restoreBounds(win(5000, 5000, 800, 600), [primary])).toEqual(defaultOnPrimary);
    });
  });

  describe("the default placement", () => {
    it("centers on the primary display even when it is not first in the list", () => {
      expect(restoreBounds(null, [right, primary])).toEqual(defaultOnPrimary);
    });

    it("centers on a primary display with a negative origin", () => {
      const p: DisplayArea = {
        id: "p",
        primary: true,
        workArea: { x: -1920, y: 0, width: 1920, height: 1080 },
      };
      expect(restoreBounds(null, [p, right])).toEqual({
        x: -1600,
        y: 140,
        width: 1280,
        height: 800,
      });
    });

    it("clamps to a work area smaller than 1280 by 800", () => {
      const small: DisplayArea = {
        id: "s",
        primary: true,
        workArea: { x: 10, y: 20, width: 1024, height: 700 },
      };
      expect(restoreBounds(null, [small])).toEqual({ x: 10, y: 20, width: 1024, height: 700 });
    });

    it("clamps one dimension only when only one is too small", () => {
      const wide: DisplayArea = {
        id: "w",
        primary: true,
        workArea: { x: 0, y: 0, width: 2560, height: 600 },
      };
      expect(restoreBounds(null, [wide])).toEqual({ x: 640, y: 0, width: 1280, height: 600 });
    });

    it("rounds an odd remainder down to whole pixels", () => {
      const odd: DisplayArea = {
        id: "o",
        primary: true,
        workArea: { x: 0, y: 0, width: 1921, height: 1081 },
      };
      expect(restoreBounds(null, [odd])).toEqual({ x: 320, y: 140, width: 1280, height: 800 });
    });

    it("uses the first display when none is flagged primary", () => {
      const a: DisplayArea = { ...right, primary: false };
      expect(restoreBounds(null, [a, left])).toEqual({ x: 1920, y: 112, width: 1280, height: 800 });
    });

    it("still returns a usable default when no display is connected", () => {
      expect(restoreBounds(null, [])).toEqual({ x: 0, y: 0, width: 1280, height: 800 });
      expect(restoreBounds(win(100, 100), [])).toEqual({ x: 0, y: 0, width: 1280, height: 800 });
    });
  });
});
