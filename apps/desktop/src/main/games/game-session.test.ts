import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ session: {} }));

const { createDenialLog, installBaselineHandlers, setUpGameSession } = await import(
  "./game-session.js"
);

const GAME = "0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7b";

function fakeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), flush: vi.fn(async () => undefined) };
}

describe("createDenialLog: at most once a minute per game and permission", () => {
  it("logs the first denial, suppresses repeats for 60 s and reports how many were suppressed", () => {
    let now = 1_000_000;
    const log = fakeLog();
    const deny = createDenialLog({ log, gameId: GAME, now: () => now });

    deny("geolocation", "https://game.example", "request");
    deny("geolocation", "https://game.example", "check");
    now += 59_999;
    deny("geolocation", "https://game.example", "check");
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenLastCalledWith("game.permission-denied", {
      gameId: GAME,
      permission: "geolocation",
      origin: "https://game.example",
      via: "request",
      suppressed: 0,
    });

    now += 1;
    deny("geolocation", "https://game.example", "check");
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenLastCalledWith("game.permission-denied", {
      gameId: GAME,
      permission: "geolocation",
      origin: "https://game.example",
      via: "check",
      suppressed: 2,
    });
  });

  it("counts each permission on its own", () => {
    const log = fakeLog();
    const deny = createDenialLog({ log, gameId: GAME, now: () => 5 });
    deny("geolocation", "https://game.example", "request");
    deny("notifications", "https://game.example", "request");
    deny("media", "https://game.example", "check");
    deny("notifications", "https://game.example", "request");
    expect(log.warn).toHaveBeenCalledTimes(3);
  });

  it("logs only the origin of a requesting URL", () => {
    const log = fakeLog();
    const deny = createDenialLog({ log, gameId: GAME, now: () => 5 });
    deny("media", "https://game.example/level/2?token=secret", "request");
    expect(log.warn.mock.calls[0]?.[1]).toMatchObject({ origin: "https://game.example" });
  });
});

/** A Session stand-in that records the handlers installed on it. */
function fakeSession() {
  const emitter = new EventEmitter();
  const fake = Object.assign(emitter, {
    request: null as null | ((...args: unknown[]) => void),
    check: null as null | ((...args: unknown[]) => boolean),
    device: null as null | ((...args: unknown[]) => boolean),
    bluetooth: null as null | ((...args: unknown[]) => void),
    spellChecker: true,
    displayMedia: false,
    setPermissionRequestHandler(handler: (...args: unknown[]) => void) {
      fake.request = handler;
    },
    setPermissionCheckHandler(handler: (...args: unknown[]) => boolean) {
      fake.check = handler;
    },
    setDevicePermissionHandler(handler: (...args: unknown[]) => boolean) {
      fake.device = handler;
    },
    setBluetoothPairingHandler(handler: (...args: unknown[]) => void) {
      fake.bluetooth = handler;
    },
    setDisplayMediaRequestHandler() {
      fake.displayMedia = true;
    },
    setSpellCheckerEnabled(enabled: boolean) {
      fake.spellChecker = enabled;
    },
  });
  return fake;
}

const NAMES = [
  "fullscreen",
  "pointerLock",
  "keyboardLock",
  "media",
  "display-capture",
  "geolocation",
  "notifications",
  "clipboard-read",
  "hid",
  "serial",
  "usb",
  "openExternal",
  "unknown",
  "Fullscreen",
];

describe("setUpGameSession (security.md section 5, AC-4)", () => {
  it("allows exactly fullscreen, pointerLock and keyboardLock in both handlers and denies the rest", () => {
    const ses = fakeSession();
    setUpGameSession(ses as never, GAME, { log: fakeLog() });
    const requested: Record<string, boolean> = {};
    const checked: Record<string, boolean> = {};
    for (const name of NAMES) {
      ses.request?.(null, name, (granted: boolean) => (requested[name] = granted), {
        requestingUrl: "https://game.example/",
      });
      checked[name] = ses.check?.(null, name, "https://game.example", {}) ?? true;
    }
    const allowed = ["fullscreen", "pointerLock", "keyboardLock"];
    for (const name of NAMES) {
      expect([name, requested[name]]).toEqual([name, allowed.includes(name)]);
      expect([name, checked[name]]).toEqual([name, allowed.includes(name)]);
    }
  });

  it("logs a denial (rate-limited) but never an allowed permission", () => {
    const ses = fakeSession();
    const log = fakeLog();
    setUpGameSession(ses as never, GAME, { log, now: () => 0 });
    ses.request?.(null, "fullscreen", () => undefined, { requestingUrl: "https://game.example/" });
    ses.request?.(null, "geolocation", () => undefined, { requestingUrl: "https://game.example/" });
    ses.check?.(null, "geolocation", "https://game.example", {});
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]?.[1]).toMatchObject({ permission: "geolocation" });
  });

  it("refuses devices, cancels every chooser and turns the spell checker off", () => {
    const ses = fakeSession();
    setUpGameSession(ses as never, GAME, { log: fakeLog() });
    expect(ses.device?.({ deviceType: "hid" })).toBe(false);
    expect(ses.spellChecker).toBe(false);
    expect(ses.displayMedia).toBe(false);

    const event = () => ({ preventDefault: vi.fn() });
    const hid = vi.fn();
    const hidEvent = event();
    ses.emit("select-hid-device", hidEvent, { deviceList: [{ deviceId: "a" }] }, hid);
    expect(hidEvent.preventDefault).toHaveBeenCalled();
    expect(hid).toHaveBeenCalledWith();

    const serial = vi.fn();
    ses.emit("select-serial-port", event(), [{ portId: "p" }], null, serial);
    expect(serial).toHaveBeenCalledWith("");

    const usb = vi.fn();
    ses.emit("select-usb-device", event(), { deviceList: [{ deviceId: "u" }] }, usb);
    expect(usb).toHaveBeenCalledWith();

    const pairing = vi.fn();
    ses.bluetooth?.({ deviceId: "b", pairingKind: "confirm" }, pairing);
    expect(pairing).toHaveBeenCalledWith({ confirmed: false });
  });

  it("cancels every download and logs it", () => {
    const ses = fakeSession();
    const log = fakeLog();
    setUpGameSession(ses as never, GAME, { log });
    const downloadEvent = { preventDefault: vi.fn() };
    ses.emit("will-download", downloadEvent, { getURL: () => "https://game.example/file.zip?t=1" });
    expect(downloadEvent.preventDefault).toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith("game.download-refused", {
      gameId: GAME,
      origin: "https://game.example",
    });
  });
});

describe("installBaselineHandlers", () => {
  it("installs deny-all handlers on every new session and refuses webviews and new windows", () => {
    const app = new EventEmitter();
    const log = fakeLog();
    installBaselineHandlers(app as never, log);

    const ses = fakeSession();
    app.emit("session-created", ses);
    let granted: boolean | null = null;
    ses.request?.(null, "fullscreen", (value: boolean) => (granted = value), {});
    expect(granted).toBe(false);
    expect(ses.check?.(null, "fullscreen", "https://x.example", {})).toBe(false);
    expect(ses.device?.({})).toBe(false);
    const downloadEvent = { preventDefault: vi.fn() };
    ses.emit("will-download", downloadEvent, {});
    expect(downloadEvent.preventDefault).toHaveBeenCalled();

    const contents = Object.assign(new EventEmitter(), {
      openHandler: null as null | ((details: unknown) => unknown),
      setWindowOpenHandler(handler: (details: unknown) => unknown) {
        contents.openHandler = handler;
      },
    });
    app.emit("web-contents-created", {}, contents);
    expect(contents.openHandler?.({ url: "https://x.example/" })).toEqual({ action: "deny" });
    const webviewEvent = { preventDefault: vi.fn() };
    contents.emit("will-attach-webview", webviewEvent, {}, {});
    expect(webviewEvent.preventDefault).toHaveBeenCalled();

    const certificate = vi.fn();
    const certificateEvent = { preventDefault: vi.fn() };
    app.emit(
      "select-client-certificate",
      certificateEvent,
      null,
      "https://x.example/",
      [{}],
      certificate,
    );
    expect(certificateEvent.preventDefault).toHaveBeenCalled();
    expect(certificate).toHaveBeenCalledWith();
  });
});
