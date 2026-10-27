// Machine-path leak check (see "Documentation rules" in AGENTS.md: never commit absolute home paths, local
// usernames or other machine-specific paths). This repository is public, and secretlint does not catch these.
//
// `findMachinePaths` finds POSIX and Windows home paths, macOS temporary roots, and caller-supplied needles
// (the CLI passes the current user's home directory and username). A finding holds a position and a kind, never the
// matched text: the point is to keep a username out of terminals and CI logs.
//
// CLI: `node scripts/check-machine-paths.mjs [files...]`. Without files it checks every text file git tracks, except
// `pnpm-lock.yaml`. Binary files (a NUL byte, or `-text` in `git ls-files --eol`) are skipped. This file avoids literal
// machine paths in its own source, because the check runs on it too.

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, isAbsolute, relative } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * @typedef {object} Finding
 * @property {number} line 1-based
 * @property {number} column 1-based
 * @property {string} kind `posix-home`, `home-slug`, `windows-home`, `macos-temp` or `current-user`
 */

/**
 * The only user name under the Linux home root that may appear. Emscripten's IDBFS test setups (the progress-lab
 * fixture and the snapshot test vectors) use this fixed path; it is not a real person's directory. Nothing else is
 * allowed, and it does not apply to the macOS home root.
 */
const ALLOWED_LINUX_HOME_NAMES = Object.freeze(["web_user"]);

/** Needles shorter than this are skipped: a two-letter user name would match half of the repository. */
const MIN_NEEDLE_LENGTH = 3;

/** Files never checked: generated, and full of package names and URLs. */
const EXCLUDED_BASENAMES = new Set(["pnpm-lock.yaml"]);

// A path must start where a path can start: not inside a word, a host name (`example.com/...`) or a relative path
// (`../...`), and not right after a standalone drive letter (the Windows pattern owns that case). The drive letter
// must itself start a word: the `n:` in `bin:` of a PATH-style list is not a drive.
const PATH_START = "(?<![A-Za-z0-9_.~-])(?<!(?<![A-Za-z0-9])[A-Za-z]:)";
const NAME = String.raw`[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*`;

const POSIX_HOME = new RegExp(String.raw`${PATH_START}\/(Users|home)\/(${NAME})`, "g");
// Tools such as Claude Code name a project directory after its path with the separators turned into hyphens
// (`-Users-<name>-<repo>`). The slug must start a token, so ordinary hyphenated words do not match.
const HOME_SLUG = /(?<![A-Za-z0-9_.~-])-(Users|home)-([A-Za-z0-9_]+)-/g;
const WINDOWS_HOME = /(?<![A-Za-z0-9])[A-Za-z]:[\\/]+Users[\\/]+[A-Za-z0-9_]/gi;
const MACOS_TEMP = new RegExp(
  String.raw`${PATH_START}\/(?:private\/(?:var\/folders|tmp)|var\/folders)\/`,
  "g",
);

/**
 * @param {string} text
 * @param {{ extraNeedles?: readonly string[] }} [opts] extra strings that must not appear anywhere (case-sensitive,
 *   substring match), for example the current user's home directory and user name
 * @returns {Finding[]} sorted by line, then column
 */
export function findMachinePaths(text, { extraNeedles = [] } = {}) {
  const needles = extraNeedles.filter((needle) => needle.length >= MIN_NEEDLE_LENGTH);
  /** @type {Finding[]} */
  const findings = [];
  const seen = new Set();

  /** @param {number} line @param {number} index @param {string} kind */
  const add = (line, index, kind) => {
    const key = `${line}:${index}`;
    if (!seen.has(key)) {
      seen.add(key);
      findings.push({ line, column: index + 1, kind });
    }
  };

  const lines = text.split("\n");
  for (const [i, content] of lines.entries()) {
    const line = i + 1;
    for (const match of content.matchAll(POSIX_HOME)) {
      const [, root, name] = match;
      if (root === "home" && name !== undefined && ALLOWED_LINUX_HOME_NAMES.includes(name)) {
        continue;
      }
      add(line, match.index, "posix-home");
    }
    for (const match of content.matchAll(HOME_SLUG)) {
      const [, root, name] = match;
      if (root === "home" && name !== undefined && ALLOWED_LINUX_HOME_NAMES.includes(name)) {
        continue;
      }
      add(line, match.index, "home-slug");
    }
    for (const match of content.matchAll(WINDOWS_HOME)) {
      add(line, match.index, "windows-home");
    }
    for (const match of content.matchAll(MACOS_TEMP)) {
      add(line, match.index, "macos-temp");
    }
    for (const needle of needles) {
      for (
        let from = content.indexOf(needle);
        from !== -1;
        from = content.indexOf(needle, from + needle.length)
      ) {
        add(line, from, "current-user");
      }
    }
  }

  return findings.sort((a, b) => a.line - b.line || a.column - b.column);
}

/**
 * One report line: where and what, never the matched text.
 * @param {string} file
 * @param {Finding} finding
 * @returns {string}
 */
export function formatFinding(file, finding) {
  return `${file}:${finding.line}:${finding.column} ${finding.kind}`;
}

/**
 * Text files tracked by git. `--eol` marks files git treats as binary with `-text`.
 * @returns {string[]}
 */
function trackedTextFiles() {
  // The command is a constant: nothing user-controlled reaches it.
  const output = execFileSync("git", ["ls-files", "-z", "--eol"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const files = [];
  for (const entry of output.split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab === -1) {
      continue;
    }
    const info = entry.slice(0, tab);
    if (/(?:^|\s)[iw]\/-text(?:\s|$)/.test(info)) {
      continue;
    }
    files.push(entry.slice(tab + 1));
  }
  return files;
}

/**
 * The strings that identify the machine this runs on. Not used on CI: a runner's identity is not a secret and its
 * generic user name (`runner`) would match ordinary words in the documentation; the path patterns still apply there.
 * @returns {string[]}
 */
function currentMachineNeedles() {
  if (process.env.CI === "true") {
    return [];
  }
  const needles = [];
  try {
    needles.push(homedir(), userInfo().username);
  } catch {
    // No home directory or user entry (for example a container without one): nothing to add.
  }
  return needles.filter((needle) => needle.length >= MIN_NEEDLE_LENGTH);
}

function main() {
  const args = process.argv.slice(2);
  let files;
  try {
    files = args.length > 0 ? args : trackedTextFiles();
  } catch (error) {
    console.error("Could not list tracked files from git.");
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }

  const extraNeedles = currentMachineNeedles();
  let checked = 0;
  let found = 0;
  for (const file of files) {
    if (EXCLUDED_BASENAMES.has(basename(file))) {
      continue;
    }
    // Never echo an absolute path: it would hold the home directory.
    const shown = isAbsolute(file) ? relative(process.cwd(), file) : file;
    /** @type {Buffer} */
    let data;
    try {
      data = readFileSync(file);
    } catch (error) {
      // A tracked file deleted in the working tree is not this check's concern.
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        continue;
      }
      // Any other failure: say which file, and nothing else (a stack trace or error message holds absolute paths).
      console.error(`Could not read ${shown}.`);
      process.exitCode = 2;
      return;
    }
    if (data.includes(0)) {
      continue;
    }
    checked++;
    for (const finding of findMachinePaths(data.toString("utf8"), { extraNeedles })) {
      console.error(formatFinding(shown, finding));
      found++;
    }
  }

  if (found > 0) {
    console.error(
      `\nFAIL: ${found} machine-specific path(s) in ${checked} checked file(s). Replace them with a placeholder or a relative path.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(`OK: no machine-specific paths (${checked} files checked).`);
}

/**
 * True when this file is the script node was started with (compared by real path, so a symlinked checkout does not
 * turn the gate into a no-op). A missing or unreadable `process.argv[1]` means this module was imported.
 * @returns {boolean}
 */
function isEntryPoint() {
  const entryPoint = process.argv[1];
  if (entryPoint === undefined) {
    return false;
  }
  try {
    return import.meta.url === pathToFileURL(realpathSync(entryPoint)).href;
  } catch {
    return false;
  }
}

// Run only when executed directly (not when imported by the tests).
if (isEntryPoint()) {
  main();
}
