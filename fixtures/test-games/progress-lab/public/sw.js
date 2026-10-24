// Precaches the game's assets and serves them cache-first. Relative URLs resolve against this
// script, so the same file works at / and under /coi/. Bump CACHE_NAME when an asset changes.
const CACHE_NAME = "progress-lab-assets-v1";
const PRECACHE = ["./", "index.html", "game.js"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith("progress-lab-assets-") && name !== CACHE_NAME)
            .map((name) => caches.delete(name)),
        ),
      ),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  // ignoreSearch: /?ephemeral=1 is the same document as /.
  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((cached) => cached ?? fetch(request)),
  );
});
