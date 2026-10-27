import { describe, expect, it } from "vitest";
import { fixPartitioningSwitch } from "./start-up.js";

/** A stand-in for Electron's `app.commandLine`: the last appended value of a switch wins. */
function commandLine(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set("disable-features", initial);
  const appended: Array<[string, string | undefined]> = [];
  return {
    appended,
    getSwitchValue: (name: string) => values.get(name) ?? "",
    appendSwitch: (name: string, value?: string) => {
      appended.push([name, value]);
      values.set(name, value ?? "");
    },
  };
}

describe("fixPartitioningSwitch", () => {
  it("re-appends --disable-features without ThirdPartyStoragePartitioning, keeping the others in order", () => {
    const line = commandLine("PaintHolding,ThirdPartyStoragePartitioning,Translate");
    expect(fixPartitioningSwitch(line)).toEqual({
      before: "PaintHolding,ThirdPartyStoragePartitioning,Translate",
      after: "PaintHolding,Translate",
    });
    expect(line.appended).toEqual([["disable-features", "PaintHolding,Translate"]]);
    expect(line.getSwitchValue("disable-features")).toBe("PaintHolding,Translate");
  });

  it("removes every occurrence of the feature", () => {
    const line = commandLine("ThirdPartyStoragePartitioning,A,ThirdPartyStoragePartitioning");
    expect(fixPartitioningSwitch(line)?.after).toBe("A");
  });

  it("appends an empty list when the feature was the only one", () => {
    const line = commandLine("ThirdPartyStoragePartitioning");
    expect(fixPartitioningSwitch(line)?.after).toBe("");
    expect(line.appended).toEqual([["disable-features", ""]]);
  });

  it("changes nothing when the switch is absent", () => {
    const line = commandLine();
    expect(fixPartitioningSwitch(line)).toBeNull();
    expect(line.appended).toEqual([]);
  });

  it("changes nothing when the switch does not disable partitioning", () => {
    const line = commandLine("PaintHolding,Translate");
    expect(fixPartitioningSwitch(line)).toBeNull();
    expect(line.appended).toEqual([]);
  });

  it("does not treat a feature that only contains the name as the feature", () => {
    const line = commandLine("ThirdPartyStoragePartitioningExtra");
    expect(fixPartitioningSwitch(line)).toBeNull();
  });
});
