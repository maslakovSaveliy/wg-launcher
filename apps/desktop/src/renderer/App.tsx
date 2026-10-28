// The launcher UI. Plain and functional in Phase 1 (plan, "Scope of the UI"): standard controls, no design work.
// Rendering rules (security.md section 6): text only, no innerHTML, no game URL in href or src.

import { useState } from "react";
import { Library } from "./library/Library.js";
import { Settings } from "./settings/Settings.js";

type View = "library" | "settings";

export function App() {
  const [view, setView] = useState<View>("library");
  if (!window.wg) {
    return (
      <main>
        <h1>WGLauncher</h1>
        <p role="alert">The launcher bridge is missing, so the library cannot be shown.</p>
      </main>
    );
  }
  return (
    <main>
      <header>
        <h1>WGLauncher</h1>
        <nav aria-label="Views">
          <button
            type="button"
            aria-pressed={view === "library"}
            onClick={() => setView("library")}
          >
            Library
          </button>
          <button
            type="button"
            aria-pressed={view === "settings"}
            onClick={() => setView("settings")}
          >
            Settings
          </button>
        </nav>
      </header>
      {view === "library" ? <Library /> : <Settings />}
    </main>
  );
}
