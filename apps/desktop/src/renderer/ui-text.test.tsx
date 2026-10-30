// The launcher's text, rendered to static markup in every state the components know (AC-14, save-transfer.md
// section 7): no install, sync, FPS, download, completion or achievement wording anywhere; every unconfirmed snapshot
// says "flush unconfirmed" and none is a save point or guaranteed; badges only from the card's recorded badges; no
// percentage without a total. Effects do not run in static rendering, so nothing here calls the bridge.

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
import { describe, expect, it } from "vitest";
import { GameCard } from "./library/GameCard.js";
import { RecoveryBanner } from "./recovery/RecoveryBanner.js";
import { FrameChoices } from "./snapshots/ExportPanel.js";
import { MappingForm } from "./snapshots/MappingForm.js";
import { SnapshotList } from "./snapshots/SnapshotList.js";
import { TaskStatus } from "./snapshots/TaskStatus.js";

const GAME = "0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7b";
const REV = "0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a70";
const none = () => undefined;

/** Words no launcher text may show (AGENTS.md honesty rules 1 and 2, save-transfer.md section 7). */
const FORBIDDEN =
  /install|\bsync|\bfps\b|download|complet|achievement|save point|guarantee|percent/i;

const text = (element: ReactElement) => renderToStaticMarkup(element);

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
  );
  return views;
}

describe("launcher text (AC-14)", () => {
  it("no view shows install, sync, FPS, download, completion or achievement wording", () => {
    for (const view of everyView()) expect(view).not.toMatch(FORBIDDEN);
  });

  it("no view shows a percentage, because no event here carries a total", () => {
    for (const view of everyView()) expect(view).not.toMatch(/\d\s*%/);
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
