// The launcher's text, rendered to static markup in every state the components know (AC-14, save-transfer.md
// section 7): no install, sync, FPS, download, completion or achievement wording anywhere; every unconfirmed snapshot
// says "flush unconfirmed" and none is a save point or guaranteed; badges only from the card's recorded badges; no
// percentage without a total. Effects do not run in static rendering, so nothing here calls the bridge; each
// component is rendered in every state it can show, those reached only through the bridge through their pure parts.
// Text that main writes (refusal messages, the read-only reason) is not the page's own wording.

import {
  type Card,
  type FrameSummary,
  GAME_STATES,
  type SnapshotRow,
  type TaskProgressEvent,
  taskProgressEventSchema,
} from "@wg-launcher/shared";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import { AddGame } from "./library/AddGame.js";
import { GameCard } from "./library/GameCard.js";
import { RecoveryBanner } from "./recovery/RecoveryBanner.js";
import { Settings } from "./settings/Settings.js";
import { ExportBody, FrameChoices } from "./snapshots/ExportPanel.js";
import { MappingForm } from "./snapshots/MappingForm.js";
import { SnapshotList } from "./snapshots/SnapshotList.js";
import { SnapshotSources } from "./snapshots/SnapshotsPanel.js";
import { TaskStatus } from "./snapshots/TaskStatus.js";

const GAME = "0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7b";
const REV = "0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a70";
const none = () => undefined;

/** Words no launcher text may show (AGENTS.md honesty rules 1 and 2, save-transfer.md section 7). */
const FORBIDDEN =
  /install|\bsync|\bfps\b|download|complet|achievement|save point|guarantee|percent/i;

const text = (element: ReactElement) => renderToStaticMarkup(element);

/** What a person meets in markup: the text between tags and the accessible labels, not attribute names or values. */
const wording = (markup: string) =>
  [
    ...[...markup.matchAll(/aria-label="([^"]*)"/g)].map((match) => match[1]),
    markup.replace(/<[^>]*>/g, " "),
  ].join(" ");

const card = (overrides: Partial<Card> = {}): Card => ({
  gameId: GAME,
  title: "Progress Lab",
  url: "http://localhost:4317/",
  coverUrl: null,
  badges: [
    { id: "by-link" },
    { id: "needs-internet" },
    { id: "local-data", checkedAt: 1_800_000_000_000 },
    { id: "export-verified" },
    { id: "compat-not-verified" },
  ],
  lastLaunchedAt: 1_800_000_000_000,
  playtimeMs: 3_900_000,
  state: "idle",
  needsRecovery: false,
  ...overrides,
});

const row = (overrides: Partial<SnapshotRow> = {}): SnapshotRow => ({
  revisionId: REV,
  gameId: GAME,
  kind: "export",
  createdAt: "2026-10-30T12:00:00.000Z",
  parentRevisionId: null,
  exporter: { id: "generic-web-storage", version: "1.0.0" },
  adapter: null,
  contentHash: "a".repeat(64),
  sizeBytes: 20_480,
  flushState: "unconfirmed",
  verifiedAt: null,
  addedAt: 1_800_000_000_000,
  ...overrides,
});

const frame: FrameSummary = {
  origin: "http://127.0.0.1:4317",
  topLevelSite: "http://localhost",
  inExport: false,
  localStorageItems: 2,
  databases: 2,
  indexedDbBytes: 23_361,
};

/** Every kind, step and status task:progress can carry, with and without a failure. */
function everyTask(): TaskProgressEvent[] {
  const shape = taskProgressEventSchema.shape;
  const events: TaskProgressEvent[] = [];
  for (const kind of shape.kind.options) {
    for (const step of shape.step.options) {
      for (const status of shape.status.options) {
        events.push({
          taskId: REV,
          gameId: GAME,
          kind,
          step,
          status,
          bytesDone: 4096,
          ...(status === "failed"
            ? { code: "EXP_UNSUPPORTED_VALUE", message: "A value at store x, key 3 is a function." }
            : {}),
        });
      }
    }
  }
  return events;
}

function everyView(): string[] {
  const views: string[] = [];
  for (const state of GAME_STATES) {
    for (const needsRecovery of [false, true]) {
      for (const task of [null, ...everyTask().slice(0, 40)]) {
        views.push(
          text(
            <GameCard
              card={card({ state, needsRecovery })}
              canCreateShortcuts
              task={task}
              sameOrigin={[]}
              onChanged={async () => undefined}
            />,
          ),
        );
      }
    }
  }
  for (const task of everyTask()) views.push(text(<TaskStatus task={task} />));
  views.push(
    text(
      <SnapshotList
        label="Snapshots"
        rows={[
          row(),
          row({ revisionId: GAME, kind: "backup", flushState: "confirmed", verifiedAt: 1 }),
          row({ kind: "imported" }),
        ]}
        actions={{ onRestore: none, onVerify: none, onSaveAs: none }}
      />,
    ),
    text(
      <FrameChoices
        frames={[frame, { ...frame, indexedDbBytes: null }]}
        chosen={[]}
        onToggle={none}
      />,
    ),
    text(<FrameChoices frames={[]} chosen={[]} onToggle={none} />),
    text(<MappingForm fromFile onSubmit={none} onCancel={none} />),
    text(<MappingForm fromFile={false} onSubmit={none} onCancel={none} />),
    text(<RecoveryBanner onRetry={none} />),
    text(<AddGame onAdded={async () => undefined} />),
    text(<Settings />),
    text(<SnapshotSources listed={null} actions={{}} onFile={none} onClose={none} />),
    text(
      <SnapshotSources
        listed={{ own: [row()], others: [{ card: card({ title: "Lab B" }), rows: [row()] }] }}
        actions={{ onRestore: none, onVerify: none, onSaveAs: none, onRestoreOther: none }}
        onFile={none}
        onClose={none}
      />,
    ),
  );
  for (const view of exportViews()) views.push(text(view));
  // The whole page: the views bar and the library before its first answer (no bridge call runs here).
  vi.stubGlobal("window", { wg: {} });
  views.push(text(<App />));
  // Without the preload: the notice that the bridge is missing.
  vi.stubGlobal("window", {});
  views.push(text(<App />));
  vi.unstubAllGlobals();
  return views;
}

/** The export panel in each of its states, the 32-frame limit included. */
function exportViews(): ReactElement[] {
  const many = Array.from({ length: 33 }, (_, i) => ({ ...frame, origin: `http://f${i}.test` }));
  const body = (view: Parameters<typeof ExportBody>[0]["view"], chosen = [] as FrameSummary[]) => (
    <ExportBody view={view} chosen={chosen} onToggle={none} onStart={none} />
  );
  return [
    body({ kind: "reading" }),
    body({ kind: "error", code: "EXP_TIMEOUT", message: "A frame of the job window is missing." }),
    body({ kind: "ready", frames: [frame] }),
    body({ kind: "ready", frames: [] }),
    body({ kind: "ready", frames: many }, many),
  ];
}

describe("launcher text (AC-14)", () => {
  it("no view shows install, sync, FPS, download, completion or achievement wording", () => {
    for (const view of everyView()) expect(wording(view)).not.toMatch(FORBIDDEN);
  });

  it("no view shows a percentage, because no event here carries a total", () => {
    for (const view of everyView()) expect(wording(view)).not.toMatch(/\d\s*%/);
  });

  it("a card shows the badges it was given and no other", () => {
    const bare = text(
      <GameCard
        card={card({ badges: [] })}
        canCreateShortcuts
        task={null}
        sameOrigin={[]}
        onChanged={async () => undefined}
      />,
    );
    for (const label of [
      "By link",
      "Needs internet",
      "Local data",
      "Export verified",
      "Compatibility",
    ]) {
      expect(bare).not.toContain(label);
    }
  });

  it("a game that needs recovery shows the banner with Retry recovery", () => {
    const view = text(
      <GameCard
        card={card({ needsRecovery: true })}
        canCreateShortcuts
        task={null}
        sameOrigin={[]}
        onChanged={async () => undefined}
      />,
    );
    expect(view).toContain("Retry recovery");
  });
});

describe("the export panel (save-transfer.md section 6, Export)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("still offers the export when the frame list could not be read, and shows the code", () => {
    const view = text(
      <ExportBody
        view={{
          kind: "error",
          code: "EXP_TIMEOUT",
          message: "A frame of the job window is missing.",
        }}
        chosen={[]}
        onToggle={none}
        onStart={none}
      />,
    );
    expect(view).toContain("EXP_TIMEOUT: A frame of the job window is missing.");
    expect(view).toMatch(/<button[^>]*>Start export<\/button>/);
  });

  it("refuses to start with more than 32 frames ticked, saying why", () => {
    const many = Array.from({ length: 33 }, (_, i) => ({ ...frame, origin: `http://f${i}.test` }));
    const view = text(
      <ExportBody
        view={{ kind: "ready", frames: many }}
        chosen={many}
        onToggle={none}
        onStart={none}
      />,
    );
    expect(view).toContain("at most 32");
    expect(view).toMatch(/<button[^>]*disabled=""[^>]*>Start export<\/button>/);
  });
});

describe("flush state in the snapshot list (save-transfer.md section 7)", () => {
  it("every unconfirmed row says flush unconfirmed, a confirmed row does not", () => {
    const rows = [
      row(),
      row({ revisionId: GAME, flushState: "confirmed" }),
      row({ kind: "imported" }),
    ];
    const view = text(<SnapshotList label="Snapshots" rows={rows} />);
    const items = view.split("<li ").slice(1);
    expect(items).toHaveLength(3);
    for (const [index, item] of items.entries()) {
      expect(item.includes("flush unconfirmed")).toBe(rows[index]?.flushState === "unconfirmed");
    }
  });
});
