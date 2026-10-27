// The launcher UI. Plain and functional in Phase 1 (plan, "Scope of the UI"); the library comes with Task 9.
// Rendering rules (security.md section 6): text only, no innerHTML, no game URL in href or src.

export function App() {
  const bridge = window.wgLauncher;
  return (
    <main>
      <h1>WGLauncher</h1>
      <p>The game library is not part of this build yet.</p>
      <p id="bridge-status">
        {bridge
          ? `Launcher bridge connected (version ${bridge.bridgeVersion}).`
          : "Launcher bridge missing."}
      </p>
    </main>
  );
}
