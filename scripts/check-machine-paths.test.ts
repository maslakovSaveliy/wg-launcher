import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findMachinePaths, formatFinding } from "./check-machine-paths.mjs";

// Test inputs are built by concatenation so that this file holds no literal machine path:
// the check runs on this file too.
const MAC_HOME = "/Us" + "ers/";
const LINUX_HOME = "/ho" + "me/";
const PRIVATE = "/priv" + "ate/";
const VAR_FOLDERS = "/v" + "ar/folders/";
const NAME = "jdoe42";

describe("findMachinePaths", () => {
  it("detects a macOS home path with its line and column", () => {
    const text = `first line\nsee ${MAC_HOME}${NAME}/project/file.txt here`;

    expect(findMachinePaths(text)).toEqual([{ line: 2, column: 5, kind: "posix-home" }]);
  });

  it("detects a Linux home path", () => {
    expect(findMachinePaths(`x ${LINUX_HOME}${NAME}/game`)).toEqual([
      { line: 1, column: 3, kind: "posix-home" },
    ]);
  });

  it("detects Windows home paths with any drive letter and either slash", () => {
    const users = "Us" + "ers";
    const backslashes = `C:\\${users}\\${NAME}\\Documents`;
    const slashes = `d:/${users}/${NAME}/Documents`;
    const doubled = `E:\\\\${users}\\\\${NAME}`;

    expect(findMachinePaths(backslashes)).toEqual([{ line: 1, column: 1, kind: "windows-home" }]);
    expect(findMachinePaths(slashes)).toEqual([{ line: 1, column: 1, kind: "windows-home" }]);
    expect(findMachinePaths(doubled)).toEqual([{ line: 1, column: 1, kind: "windows-home" }]);
  });

  it("detects macOS temporary roots", () => {
    const text = [
      `a ${PRIVATE}v${"ar/folders/zz/abc/T/x"}`,
      `b ${PRIVATE}tmp/session`,
      `c ${VAR_FOLDERS}zz/abc`,
    ].join("\n");

    expect(findMachinePaths(text)).toEqual([
      { line: 1, column: 3, kind: "macos-temp" },
      { line: 2, column: 3, kind: "macos-temp" },
      { line: 3, column: 3, kind: "macos-temp" },
    ]);
  });

  it("allows the Emscripten IDBFS test path and nothing next to it", () => {
    const allowed = `${LINUX_HOME}web_user`;

    expect(findMachinePaths(allowed)).toEqual([]);
    expect(findMachinePaths(`${allowed}/save/slot1.dat`)).toEqual([]);
    expect(findMachinePaths(`"${allowed}".`)).toEqual([]);
    expect(findMachinePaths(`${allowed}x/save`)).toEqual([
      { line: 1, column: 1, kind: "posix-home" },
    ]);
    expect(findMachinePaths(`${allowed}_two/save`)).toEqual([
      { line: 1, column: 1, kind: "posix-home" },
    ]);
  });

  it("does not extend the allowlist to the other home roots", () => {
    expect(findMachinePaths(`${MAC_HOME}web_user/x`)).toEqual([
      { line: 1, column: 1, kind: "posix-home" },
    ]);
  });

  it("allows the tilde form and placeholders", () => {
    expect(findMachinePaths("~/Library/Preferences/com.example.plist")).toEqual([]);
    expect(findMachinePaths(`${MAC_HOME}<name>/x and ${LINUX_HOME}<user>/y`)).toEqual([]);
  });

  it("does not flag a URL path that merely looks similar", () => {
    expect(findMachinePaths(`https://example.com${LINUX_HOME}${NAME}`)).toEqual([]);
  });

  it("detects every extra needle, also several per line", () => {
    const text = `hello ${NAME} and ${NAME}\nnothing here`;

    expect(findMachinePaths(text, { extraNeedles: [NAME] })).toEqual([
      { line: 1, column: 7, kind: "current-user" },
      { line: 1, column: 18, kind: "current-user" },
    ]);
  });

  it("reports a pattern hit and a needle at the same position once", () => {
    const text = `${MAC_HOME}${NAME}/x`;

    expect(findMachinePaths(text, { extraNeedles: [`${MAC_HOME}${NAME}`] })).toEqual([
      { line: 1, column: 1, kind: "posix-home" },
    ]);
  });

  it("skips needles shorter than three characters", () => {
    expect(findMachinePaths("ab ab ab", { extraNeedles: ["ab", ""] })).toEqual([]);
  });

  it("counts columns per line for Windows line endings", () => {
    const text = `one\r\ntwo ${MAC_HOME}${NAME}/x`;

    expect(findMachinePaths(text)).toEqual([{ line: 2, column: 5, kind: "posix-home" }]);
  });

  it("never puts the matched text into a finding", () => {
    const text = `${MAC_HOME}${NAME}/x and ${NAME}`;
    const findings = findMachinePaths(text, { extraNeedles: [NAME] });

    expect(findings.length).toBe(3);
    expect(JSON.stringify(findings)).not.toContain(NAME);
    for (const finding of findings) {
      expect(formatFinding("docs/a.md", finding)).not.toContain(NAME);
    }
  });
});

describe("formatFinding", () => {
  it("prints file:line:column and the kind", () => {
    expect(formatFinding("docs/a.md", { line: 3, column: 9, kind: "posix-home" })).toBe(
      "docs/a.md:3:9 posix-home",
    );
  });
});

describe("check-machine-paths CLI", () => {
  const script = fileURLToPath(new URL("./check-machine-paths.mjs", import.meta.url));

  function run(contents: Buffer | string) {
    const dir = mkdtempSync(join(tmpdir(), "paths-check-"));
    try {
      const file = join(dir, "sample.txt");
      writeFileSync(file, contents);
      return spawnSync(process.execPath, [script, file], {
        encoding: "utf8",
        env: { ...process.env, CI: "true" },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("exits 0 and says OK for a clean file", () => {
    const result = run("nothing to see here\n");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OK: no machine-specific paths");
  });

  it("exits 1 for a leak and does not print the username", () => {
    const result = run(`path: ${MAC_HOME}${NAME}/x\n`);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(":1:7 posix-home");
    expect(result.stdout + result.stderr).not.toContain(NAME);
  });

  it("skips binary files (a NUL byte)", () => {
    const result = run(Buffer.from(`${MAC_HOME}${NAME}/x\0\u0001`));

    expect(result.status).toBe(0);
  });
});
