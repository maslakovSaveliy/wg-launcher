// Which stub navigations a job needs and which frame of each resolves which storage key (save-transfer.md section 5,
// step 7). Keys are grouped by top-level stub origin T, taken from the job's `top` keys first: one navigation to
// `<T>/__wg_quiescent__` resolves T's own key in the top frame and, as iframes, every partitioned key whose
// `topLevelSite` is the site of T and every first-party `frame` key of that site. A key left over gets its own
// navigation: its exact origin when first-party (resolved in the top frame), its `topLevelSite` when partitioned (an
// iframe under a top page whose own storage is not part of the job). Pure: the result is plain data.
import { siteOf } from "../../policy/site.js";
import { type StubPage, stubPage, stubUrl } from "./stub.js";

/** A storage key of the job (snapshot-format.md section 4) with its manifest index. */
export interface JobKey {
  index: number;
  origin: string;
  topLevelSite: string | null;
  role: "top" | "frame";
}

export interface FrameSlot {
  /** The stub URL of the frame that resolves `key`. */
  url: string;
  key: JobKey;
  inIframe: boolean;
}

export interface Navigation {
  topUrl: string;
  /** The frames of this navigation that resolve a key: the top frame first when it does, then the iframes. */
  frames: FrameSlot[];
}

export interface Layout {
  navigations: Navigation[];
  /** Every stub URL of the job and its page; the interceptor answers these and nothing else (QW-1). */
  pages: Map<string, StubPage>;
  /** True when some key is resolved in an iframe: only then does the preload run in subframes (QW-6). */
  subframes: boolean;
}

export function layOutNavigations(keys: readonly JobKey[], jobNonce: string): Layout {
  const byIndex = [...keys].sort((a, b) => a.index - b.index);
  const placed = new Set<number>();
  const navigations: Navigation[] = [];

  const navigate = (topOrigin: string, topKey: JobKey | null, site: string) => {
    const frames: FrameSlot[] = [];
    if (topKey !== null) {
      placed.add(topKey.index);
      frames.push({
        url: stubUrl(topOrigin, jobNonce, topKey.index),
        key: topKey,
        inIframe: false,
      });
    }
    for (const key of byIndex) {
      if (placed.has(key.index)) continue;
      const partitioned = key.topLevelSite === site;
      const firstParty =
        key.topLevelSite === null && key.role === "frame" && siteOf(key.origin) === site;
      if (partitioned || firstParty) {
        placed.add(key.index);
        frames.push({ url: stubUrl(key.origin, jobNonce, key.index), key, inIframe: true });
      }
    }
    navigations.push({
      topUrl:
        topKey === null ? stubUrl(topOrigin, jobNonce) : stubUrl(topOrigin, jobNonce, topKey.index),
      frames,
    });
  };

  for (const key of byIndex) {
    if (key.role === "top" && key.topLevelSite === null && !placed.has(key.index)) {
      navigate(key.origin, key, siteOf(key.origin));
    }
  }
  for (const key of byIndex) {
    if (placed.has(key.index)) continue;
    if (key.topLevelSite === null) navigate(key.origin, key, siteOf(key.origin));
    else navigate(key.topLevelSite, null, key.topLevelSite);
  }

  const pages = new Map<string, StubPage>();
  for (const { topUrl, frames } of navigations) {
    const iframes = frames.filter((frame) => frame.inIframe).map((frame) => frame.url);
    pages.set(topUrl, stubPage(iframes));
    for (const url of iframes) pages.set(url, stubPage([]));
  }
  return {
    navigations,
    pages,
    subframes: navigations.some(({ frames }) => frames.some((frame) => frame.inIframe)),
  };
}
