// THROWAWAY spike (runtime-compat). Atomics round trip for the cross-origin isolation check (H3, H4).
// The page stores 1 at index 0 and notifies; this worker waits for that, stores 2 at index 1 and
// notifies back. Only a real SharedArrayBuffer shared across threads completes the round trip.
self.onmessage = (event) => {
  try {
    const shared = new Int32Array(event.data);
    self.postMessage({ type: "ready" });
    const waited = Atomics.wait(shared, 0, 0, 5000);
    Atomics.store(shared, 1, 2);
    Atomics.notify(shared, 1);
    self.postMessage({ type: "done", waited, seen: Atomics.load(shared, 0) });
  } catch (error) {
    self.postMessage({ type: "error", error: `${error.name}: ${error.message}` });
  }
};
