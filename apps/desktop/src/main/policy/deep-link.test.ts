import { describe, expect, it } from "vitest";
import { parseDeepLink, parseLaunchInput } from "./deep-link.js";

// architecture.md section 8 (AC-19, S-11): the whole deep link must match
// ^wglauncher://launch/<lowercase UUIDv7>$ and the launch argument the same id; exactly one launch argument counts,
// everything else on the command line is ignored. Results never carry the raw value, only its length.

const ID = "01890a5d-ac96-774b-bcce-b302099a8057";
const LINK = `wglauncher://launch/${ID}`;
const ARG = `--launch-game=${ID}`;
const EXE = "WGLauncher";

describe("parseDeepLink", () => {
  it("accepts the exact form with a lowercase UUIDv7", () => {
    expect(parseDeepLink(LINK)).toEqual({ kind: "launch", gameId: ID });
  });

  it("refuses everything else, reporting only the length", () => {
    const bad = [
      `${LINK}/`,
      `${LINK}?x=1`,
      `${LINK}?`,
      `${LINK}#frag`,
      `${LINK}#`,
      `${LINK}/extra`,
      `wglauncher://launch/${ID.toUpperCase()}`,
      `wglauncher://launch/01890A5D-ac96-774b-bcce-b302099a8057`,
      `WGLAUNCHER://launch/${ID}`,
      `wglauncher://LAUNCH/${ID}`,
      `wglauncher://launch:80/${ID}`,
      `wglauncher://user@launch/${ID}`,
      `wglauncher://user:pass@launch/${ID}`,
      `wglauncher://evil.com@launch/${ID}`,
      `wglauncher:launch/${ID}`,
      `wglauncher:///launch/${ID}`,
      `wglauncher://launch//${ID}`,
      `wglauncher://launch/%30${ID.slice(1)}`,
      `wglauncher://open/${ID}`,
      `wglauncher://launch/`,
      `wglauncher://launch`,
      `wglauncher://launch/01890a5d-ac96-474b-bcce-b302099a8057`,
      `wglauncher://launch/01890a5d-ac96-774b-7cce-b302099a8057`,
      `wglauncher://launch/01890a5dac96774bbcceb302099a8057`,
      `wglauncher://launch/{${ID}}`,
      ` ${LINK}`,
      `${LINK} `,
      `${LINK}\n`,
      `${LINK} --disable-web-security`,
      `${LINK}%20--inspect`,
      `https://launch/${ID}`,
      `javascript:alert(1)`,
      "",
    ];
    for (const url of bad) {
      expect(parseDeepLink(url), JSON.stringify(url)).toEqual({
        kind: "invalid",
        length: url.length,
      });
    }
  });

  it("never throws, also on non-string input", () => {
    for (const url of [undefined, null, 1, {}, "\ud800"]) {
      expect(() => parseDeepLink(url as unknown as string)).not.toThrow();
      expect(parseDeepLink(url as unknown as string).kind).toBe("invalid");
    }
  });
});

describe("parseLaunchInput", () => {
  it("is none when no launch argument is present; Electron and Chromium switches and paths are ignored", () => {
    expect(parseLaunchInput([])).toEqual({ kind: "none" });
    expect(parseLaunchInput([EXE])).toEqual({ kind: "none" });
    expect(parseLaunchInput([EXE, "."])).toEqual({ kind: "none" });
    expect(
      parseLaunchInput([
        EXE,
        "out/main/index.js",
        "--inspect=9229",
        "--remote-debugging-port=0",
        "--allow-file-access-from-files",
        "--original-process-start-time=13370000000000000",
        "--",
        "-psn_0_12345",
      ]),
    ).toEqual({ kind: "none" });
  });

  it("launches from one --launch-game=<id> argument among ignored ones", () => {
    expect(parseLaunchInput([EXE, ARG])).toEqual({ kind: "launch", gameId: ID });
    expect(parseLaunchInput([EXE, "--inspect", ARG, "--no-sandbox", "."])).toEqual({
      kind: "launch",
      gameId: ID,
    });
  });

  it("launches from one argument that is a whole deep link (Windows)", () => {
    expect(parseLaunchInput([EXE, LINK])).toEqual({ kind: "launch", gameId: ID });
    expect(parseLaunchInput([EXE, "--", LINK])).toEqual({ kind: "launch", gameId: ID });
  });

  it("is invalid for a malformed launch argument", () => {
    const bad = [
      "--launch-game",
      "--launch-game=",
      `--launch-game=${ID.toUpperCase()}`,
      `--launch-game=${ID} --disable-web-security`,
      `--launch-game=${ID}--inspect`,
      `--launch-game= ${ID}`,
      `--launch-game="${ID}"`,
      `--launch-game==${ID}`,
      `--launch-games=${ID}`,
      `--launch-game-x=${ID}`,
      `--LAUNCH-GAME=${ID}`,
      `--launch-game=01890a5d-ac96-474b-bcce-b302099a8057`,
      `--launch-game=wglauncher://launch/${ID}`,
      `${LINK}/`,
      `${LINK}?a=b`,
      `${LINK} --inspect`,
      `WGLAUNCHER://launch/${ID}`,
      `wglauncher://launch/${ID.toUpperCase()}`,
    ];
    for (const arg of bad) {
      expect(parseLaunchInput([EXE, arg]), JSON.stringify(arg)).toEqual({
        kind: "invalid",
        length: arg.length,
      });
    }
  });

  it("is invalid when more than one launch argument is present, even identical ones", () => {
    for (const argv of [
      [EXE, ARG, ARG],
      [EXE, ARG, LINK],
      [EXE, LINK, LINK],
      [EXE, ARG, "--launch-game=01890a5d-ac96-774b-bcce-b302099a8058"],
      [EXE, ARG, "--launch-game"],
    ]) {
      const result = parseLaunchInput(argv);
      expect(result.kind, argv.join(" ")).toBe("invalid");
    }
  });

  it("does not treat a launch value hidden inside another switch or argument as a launch", () => {
    expect(parseLaunchInput([EXE, `--foo=${ARG}`])).toEqual({ kind: "none" });
    expect(parseLaunchInput([EXE, `--foo=${LINK}`])).toEqual({ kind: "none" });
    expect(parseLaunchInput([EXE, `x ${ARG}`])).toEqual({ kind: "none" });
    expect(parseLaunchInput([EXE, `-launch-game=${ID}`])).toEqual({ kind: "none" });
  });

  it("never throws, also on odd entries", () => {
    const odd = [undefined, null, 1, {}] as unknown as string[];
    expect(() => parseLaunchInput(odd)).not.toThrow();
    expect(parseLaunchInput(odd)).toEqual({ kind: "none" });
    expect(() => parseLaunchInput(undefined as unknown as string[])).not.toThrow();
    expect(parseLaunchInput(undefined as unknown as string[])).toEqual({ kind: "none" });
  });
});
