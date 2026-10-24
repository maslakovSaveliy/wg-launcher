// THROWAWAY spike (runtime-compat). Permission requests (H12) and gesture-gated APIs (H13).
// The host decides the permissions; this page only reports what each call returned.

const errorText = (e) => `${e?.name ?? "Error"}: ${e?.message ?? String(e)}`;

function timeout(ms, label) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}: timeout ${ms} ms`)), ms));
}

async function outcome(label, fn, ms = 8000) {
  const started = performance.now();
  try {
    const value = await Promise.race([fn(), timeout(ms, label)]);
    return { ok: true, value: value ?? null, ms: Math.round(performance.now() - started) };
  } catch (error) {
    return { ok: false, error: errorText(error), ms: Math.round(performance.now() - started) };
  }
}

function stopTracks(stream) {
  for (const track of stream.getTracks()) track.stop();
}

async function denyBatch() {
  return {
    camera: await outcome("camera", async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      stopTracks(stream);
      return "stream";
    }),
    microphone: await outcome("microphone", async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stopTracks(stream);
      return "stream";
    }),
    geolocation: await outcome(
      "geolocation",
      () =>
        new Promise((resolve, reject) =>
          navigator.geolocation.getCurrentPosition(
            () => resolve("position"),
            (error) => reject(Object.assign(new Error(error.message), { name: `GeolocationPositionError(${error.code})` })),
            { timeout: 6000 },
          ),
        ),
    ),
    notifications: await outcome("notifications", () => Notification.requestPermission()),
    notificationPermission: typeof Notification === "function" ? Notification.permission : null,
  };
}

function pointerLockOutcome(target) {
  return new Promise((resolve, reject) => {
    const onChange = () => {
      cleanup();
      if (document.pointerLockElement === target) resolve("locked");
      else reject(new Error("pointerlockchange without lock"));
    };
    const onError = () => {
      cleanup();
      reject(new Error("pointerlockerror"));
    };
    const cleanup = () => {
      document.removeEventListener("pointerlockchange", onChange);
      document.removeEventListener("pointerlockerror", onError);
    };
    document.addEventListener("pointerlockchange", onChange);
    document.addEventListener("pointerlockerror", onError);
    try {
      const promise = target.requestPointerLock();
      if (promise && typeof promise.then === "function") promise.catch((error) => {
        cleanup();
        reject(error);
      });
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

const CALLS = {
  fullscreen: () =>
    outcome("fullscreen", async () => {
      await document.documentElement.requestFullscreen();
      return document.fullscreenElement ? "fullscreen" : "no fullscreenElement";
    }),
  pointerLock: () => outcome("pointerLock", () => pointerLockOutcome(document.querySelector("#target")), 5000),
  keyboardLock: () =>
    outcome("keyboardLock", async () => {
      await navigator.keyboard.lock();
      return "locked";
    }),
};

/**
 * Starts the named gesture-gated calls synchronously, in this order, inside the current activation,
 * then awaits them. The H13 method's handler is ["fullscreen", "pointerLock", "keyboardLock"].
 */
function lockCalls(source, order = ["fullscreen", "pointerLock", "keyboardLock"]) {
  const activation = navigator.userActivation
    ? { isActive: navigator.userActivation.isActive, hasBeenActive: navigator.userActivation.hasBeenActive, hasFocus: document.hasFocus(), visibilityState: document.visibilityState }
    : null;
  const pending = order.map((name) => CALLS[name]());
  return Promise.all(pending).then((results) => {
    const out = { source, order, activation };
    order.forEach((name, i) => {
      out[name] = results[i];
    });
    return out;
  });
}

async function release() {
  try {
    navigator.keyboard?.unlock();
  } catch {}
  if (document.pointerLockElement) document.exitPointerLock();
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
  return { fullscreenElement: !!document.fullscreenElement, pointerLockElement: !!document.pointerLockElement };
}

const state = { gesture: null, display: null, clicks: [] };

const BUTTONS = {
  gesture: ["fullscreen", "pointerLock", "keyboardLock"],
  "only-fullscreen": ["fullscreen"],
  "only-pointerLock": ["pointerLock"],
  "only-keyboardLock": ["keyboardLock"],
  "pointer-first": ["pointerLock", "fullscreen", "keyboardLock"],
};
for (const [id, order] of Object.entries(BUTTONS)) {
  document.querySelector(`#${id}`).addEventListener("click", (event) => {
    state.clicks.push({ id, isTrusted: event.isTrusted, detail: event.detail });
    state.gesture = lockCalls(`${event.isTrusted ? "trusted" : "untrusted"}-${event.detail === 0 ? "keyboard" : "pointer"}-click:${id}`, order);
  });
}

document.querySelector("#display").addEventListener("click", (event) => {
  state.clicks.push({ id: "display", isTrusted: event.isTrusted });
  state.display = outcome("display-capture", async () => {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    stopTracks(stream);
    return "stream";
  });
});

window.wgPerm = {
  denyBatch,
  lockCalls,
  release,
  state,
  buttonRect: (id) => {
    const r = document.querySelector(`#${id}`).getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  },
};
document.querySelector("#status").textContent = "ready";
