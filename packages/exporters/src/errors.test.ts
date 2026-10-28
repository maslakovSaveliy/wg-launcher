import { ExportError, SnapError } from "@wg-launcher/snapshot";
import { describe, expect, it } from "vitest";
import { at, FrameFailure, toFrameError } from "./errors.js";

describe("frame error values", () => {
  it("maps a snapshot format error per direction: IMP_RECORD_INVALID on import, INTERNAL on export", () => {
    const snap = new SnapError("SNAP_RECORD_INVALID", "bad record");
    expect(toFrameError(snap, { store: "s" }, "import")).toEqual({
      code: "IMP_RECORD_INVALID",
      message: "bad record",
      detail: { store: "s" },
    });
    expect(toFrameError(snap, { store: "s" }, "export")).toMatchObject({ code: "INTERNAL" });
    expect(toFrameError(snap)).toMatchObject({ code: "INTERNAL" });
  });

  it("keeps an export error's code and path, adding where it happened", () => {
    const error = new ExportError("EXP_UNSUPPORTED_VALUE", "x", {
      path: ["a"],
      type: "[object Error]",
    });
    expect(toFrameError(error, { database: "d" }, "export")).toEqual({
      code: "EXP_UNSUPPORTED_VALUE",
      message: "x",
      detail: { database: "d", path: ["a"], type: "[object Error]" },
    });
  });

  it("names only the type of an unexpected error, never its message", () => {
    expect(toFrameError(new TypeError("secret value 42"), {}, "import")).toEqual({
      code: "INTERNAL",
      message: "unexpected TypeError in the frame",
      detail: {},
    });
  });

  it("at() rethrows with the direction it was given", () => {
    const run = () => {
      throw new SnapError("SNAP_RECORD_INVALID", "bad");
    };
    let caught: unknown;
    try {
      at({ entry: "e" }, run, "import");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FrameFailure);
    expect((caught as FrameFailure).code).toBe("IMP_RECORD_INVALID");
  });
});
