import { describe, expect, it } from "vitest";
import { liveParent } from "./dialogs.js";

describe("liveParent", () => {
  it("gives no parent for a destroyed window, so a notice still appears, unparented", () => {
    const window = {
      destroyed: false,
      isDestroyed() {
        return this.destroyed;
      },
    };
    expect(liveParent(window)).toBe(window);
    window.destroyed = true;
    expect(liveParent(window)).toBeNull();
    expect(liveParent(null)).toBeNull();
  });
});
