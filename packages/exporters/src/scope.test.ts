import { describe, expect, it } from "vitest";
import { selectsDatabase, selectsKey } from "./scope.js";

describe("selections (save-transfer.md section 8)", () => {
  it('"all" selects every localStorage key and every database', () => {
    expect(selectsKey("all", "")).toBe(true);
    expect(selectsKey("all", "anything")).toBe(true);
    expect(selectsDatabase("all", "/home/web_user")).toBe(true);
  });

  it("selects localStorage keys by plain prefix, minus excluded prefixes", () => {
    const scope = { include: ["progress-lab:", "b"], exclude: ["progress-lab:secret"] };
    expect(selectsKey(scope, "progress-lab:state")).toBe(true);
    expect(selectsKey(scope, "progress-lab:")).toBe(true);
    expect(selectsKey(scope, "bee")).toBe(true);
    expect(selectsKey(scope, "progress-lab:secret-token")).toBe(false);
    expect(selectsKey(scope, "other")).toBe(false);
    expect(selectsKey(scope, "PROGRESS-LAB:state")).toBe(false);
    expect(selectsKey({ include: [], exclude: [] }, "x")).toBe(false);
  });

  it("treats regular-expression and glob characters as plain text", () => {
    const scope = { include: ["a.*", "[ab]", "c?"], exclude: [] };
    expect(selectsKey(scope, "a.*x")).toBe(true);
    expect(selectsKey(scope, "abc")).toBe(false);
    expect(selectsKey(scope, "[ab]")).toBe(true);
    expect(selectsKey(scope, "a")).toBe(false);
    expect(selectsKey(scope, "c?")).toBe(true);
    expect(selectsKey(scope, "cx")).toBe(false);
    expect(selectsDatabase({ include: ["db.*"], exclude: [] }, "db1")).toBe(false);
    expect(selectsDatabase({ include: ["db.*"], exclude: [] }, "db.*")).toBe(true);
  });

  it("selects databases by exact name only, minus excluded names", () => {
    const scope = { include: ["progress-lab", "/home/web_user"], exclude: ["/home/web_user"] };
    expect(selectsDatabase(scope, "progress-lab")).toBe(true);
    expect(selectsDatabase(scope, "progress-lab-2")).toBe(false);
    expect(selectsDatabase(scope, "progress")).toBe(false);
    expect(selectsDatabase(scope, "/home/web_user")).toBe(false);
  });
});
