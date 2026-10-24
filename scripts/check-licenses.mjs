// Dependency license gate (see "Dependency and license policy" in AGENTS.md).
//
// Production dependencies must be permissive: every one has to match the allowlist below.
// Development-only dependencies never fail the check; outside-allowlist ones are reported as warnings.
// The data source is `pnpm licenses list --recursive --json`, run once for --prod and once for --dev.
// --recursive matters: without it pnpm reports only the root package, never the workspace members' dependencies.
// pnpm 12.15.0 does not list the workspace packages themselves (see MEMORY.md). Our own packages are AGPL-3.0-or-later,
// which is not on the allowlist, so a pnpm version that did list them would trip the gate: `workspaceNames` exempts
// exactly the packages of this workspace, and only while they carry our own license.

import { execSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * One package as printed by `pnpm licenses list --json`. pnpm also prints paths, author and so on;
 * those are ignored on purpose (paths are machine-specific).
 * @typedef {object} LicenseEntry
 * @property {string} name
 * @property {string[]} versions
 * @property {string} [license]
 */

/**
 * The pnpm report: packages grouped by their license string.
 * @typedef {Record<string, LicenseEntry[]>} PnpmLicenseReport
 */

/**
 * @typedef {object} Finding
 * @property {string} name
 * @property {string} version
 * @property {string} license
 */

/** The license of every package of this repository (see LICENSING.md). */
export const OWN_LICENSE = "AGPL-3.0-or-later";

/** SPDX identifiers allowed for production dependencies. Keep in sync with AGENTS.md. */
export const ALLOWED_LICENSES = Object.freeze([
  "MIT",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "0BSD",
  "BlueOak-1.0.0",
  "MPL-2.0",
]);

const OPERATORS = new Set(["AND", "OR", "WITH"]);

/**
 * Decide whether an SPDX license expression is acceptable. License ids are compared case-insensitively
 * (as SPDX prescribes); the operators `AND`, `OR` and `WITH` must be upper case.
 * `A OR B` needs one allowed alternative, `A AND B` needs both, AND binds tighter than OR, and
 * `A WITH exception` is judged by `A` (an exception only adds permissions). Anything that is not a
 * well-formed expression (`Unknown`, `SEE LICENSE IN ...`, unbalanced parentheses) is rejected.
 * @param {string} expression
 * @param {readonly string[]} [allowed]
 * @returns {boolean}
 */
export function isLicenseAllowed(expression, allowed = ALLOWED_LICENSES) {
  // SPDX license identifiers are matched case-insensitively; the operators stay upper case.
  const allowedIds = new Set(allowed.map((id) => id.toLowerCase()));
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let position = 0;

  /** @returns {never} */
  function fail() {
    throw new SyntaxError(`Invalid SPDX expression: ${expression}`);
  }

  /** @returns {boolean} */
  function parseTerm() {
    const token = tokens[position++];
    if (token === undefined || token === ")" || OPERATORS.has(token)) {
      return fail();
    }
    if (token === "(") {
      const inner = parseOr();
      if (tokens[position++] !== ")") {
        return fail();
      }
      return inner;
    }
    if (tokens[position] === "WITH") {
      position++;
      const exception = tokens[position++];
      if (exception === undefined || exception === "(" || exception === ")") {
        return fail();
      }
      if (OPERATORS.has(exception)) {
        return fail();
      }
    }
    return allowedIds.has(token.toLowerCase());
  }

  /** @returns {boolean} */
  function parseAnd() {
    let result = parseTerm();
    while (tokens[position] === "AND") {
      position++;
      const right = parseTerm();
      result = result && right;
    }
    return result;
  }

  /** @returns {boolean} */
  function parseOr() {
    let result = parseAnd();
    while (tokens[position] === "OR") {
      position++;
      const right = parseAnd();
      result = result || right;
    }
    return result;
  }

  try {
    const result = parseOr();
    return position === tokens.length ? result : false;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return false;
    }
    throw error;
  }
}

/**
 * @param {PnpmLicenseReport} report
 * @returns {Finding[]}
 */
function flatten(report) {
  /** @type {Finding[]} */
  const findings = [];
  for (const [group, entries] of Object.entries(report)) {
    for (const entry of entries) {
      // pnpm output is not trusted to have the documented shape: a license that is not a string counts as
      // Unknown (fails closed for production) and versions that are not an array count as none.
      const raw = entry.license ?? group;
      const license = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : "Unknown";
      const listed = Array.isArray(entry.versions) ? entry.versions : [];
      const versions = listed.length > 0 ? listed : ["unknown"];
      for (const version of versions) {
        findings.push({ name: entry.name, version, license });
      }
    }
  }
  return findings;
}

/** @param {string} a @param {string} b */
const compare = (a, b) => (a < b ? -1 : Number(a > b));

/** @param {Finding} a @param {Finding} b */
const byNameThenVersion = (a, b) => compare(a.name, b.name) || compare(a.version, b.version);

/**
 * Names of the packages of this workspace, read from `pnpm ls -r --depth -1 --json`. Only names are kept:
 * the output also holds absolute paths, which are machine-specific and never printed.
 * @param {string} output
 * @returns {Set<string>}
 */
export function parseWorkspaceNames(output) {
  const projects = JSON.parse(output);
  if (!Array.isArray(projects)) {
    throw new TypeError("Expected a JSON array of workspace projects from pnpm.");
  }
  return new Set(
    projects.flatMap((project) => (typeof project?.name === "string" ? [project.name] : [])),
  );
}

/**
 * A finding for one of our own workspace packages. Anything else, including a workspace package whose license
 * is not our own, is judged by the allowlist like every other package.
 * @param {Finding} finding
 * @param {ReadonlySet<string>} workspaceNames
 */
const isOwnPackage = (finding, workspaceNames) =>
  workspaceNames.has(finding.name) && finding.license === OWN_LICENSE;

/**
 * @param {{ prod: PnpmLicenseReport, dev: PnpmLicenseReport }} reports
 * @param {readonly string[]} [allowed]
 * @param {ReadonlySet<string>} [workspaceNames] packages of this workspace, exempt while licensed `OWN_LICENSE`
 * @returns {{ violations: Finding[], warnings: Finding[] }}
 */
export function evaluateLicenses(
  { prod, dev },
  allowed = ALLOWED_LICENSES,
  workspaceNames = new Set(),
) {
  const prodFindings = flatten(prod).filter((finding) => !isOwnPackage(finding, workspaceNames));
  const prodKeys = new Set(prodFindings.map((finding) => `${finding.name}@${finding.version}`));

  const violations = prodFindings.filter((finding) => !isLicenseAllowed(finding.license, allowed));
  // A package that is also needed in production is judged as production, never as dev-only.
  const warnings = flatten(dev).filter(
    (finding) =>
      !isOwnPackage(finding, workspaceNames) &&
      !prodKeys.has(`${finding.name}@${finding.version}`) &&
      !isLicenseAllowed(finding.license, allowed),
  );

  return {
    violations: violations.sort(byNameThenVersion),
    warnings: warnings.sort(byNameThenVersion),
  };
}

/** @param {"prod" | "dev"} scope @returns {PnpmLicenseReport} */
function readPnpmReport(scope) {
  // The command is a constant string: nothing user-controlled reaches the shell.
  const output = execSync(`pnpm licenses list --recursive --json --${scope}`, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
  return JSON.parse(output);
}

/** @returns {Set<string>} */
export function workspacePackageNames() {
  // The command is a constant string: nothing user-controlled reaches the shell.
  const output = execSync("pnpm ls -r --depth -1 --json", {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
  return parseWorkspaceNames(output);
}

/** @param {PnpmLicenseReport} report */
const countPackages = (report) => flatten(report).length;

/** @param {Finding[]} findings @param {(line: string) => void} log */
const printFindings = (findings, log) => {
  for (const finding of findings) {
    log(`  ${finding.name}@${finding.version}: ${finding.license}`);
  }
};

function main() {
  let prod;
  let dev;
  let workspaceNames;
  try {
    prod = readPnpmReport("prod");
    dev = readPnpmReport("dev");
    workspaceNames = workspacePackageNames();
  } catch (error) {
    console.error("Could not read dependency licenses from pnpm (is `pnpm install` done?).");
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }

  const { violations, warnings } = evaluateLicenses(
    { prod, dev },
    ALLOWED_LICENSES,
    workspaceNames,
  );
  console.log(`Production license allowlist: ${ALLOWED_LICENSES.join(", ")}`);
  console.log(
    `Checked ${countPackages(prod)} production and ${countPackages(dev)} development package versions.`,
  );

  if (warnings.length > 0) {
    console.log(
      `\nWarning: ${warnings.length} dev-only package(s) outside the allowlist (not blocking):`,
    );
    printFindings(warnings, console.log);
  }
  if (violations.length > 0) {
    console.error(`\nFAIL: ${violations.length} production package(s) outside the allowlist:`);
    printFindings(violations, console.error);
    process.exitCode = 1;
    return;
  }
  console.log("\nOK: all production dependencies use allowed licenses.");
}

/**
 * True when this file is the script node was started with. The real path is compared on purpose: a
 * symlinked checkout must not silently turn the gate into a no-op. A missing or unreadable
 * `process.argv[1]` (for example `node -e ... <arg>`) means this module was imported, not run.
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
