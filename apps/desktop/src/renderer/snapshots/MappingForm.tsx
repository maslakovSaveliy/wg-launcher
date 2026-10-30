// The storage-key mapping (save-transfer.md section 2, AC-24): after a refusal that names the snapshot's keys and
// this game's, the user maps origin to origin. Main checks the mapping and asks again in its own native dialog
// before anything is written; for a file the file dialog opens again, because no path is kept in the page.

import type { KeyMappingRef } from "@wg-launcher/shared";
import { type FormEvent, useState } from "react";

/** At most 32 mappings, the `snapshot:import` bound (one per storage key of a manifest). */
const MAX_ROWS = 32;

export function MappingForm({
  fromFile,
  onSubmit,
  onCancel,
}: {
  fromFile: boolean;
  onSubmit(mapping: KeyMappingRef[]): void;
  onCancel(): void;
}) {
  const [rows, setRows] = useState<KeyMappingRef[]>([{ from: "", to: "" }]);

  const edit = (index: number, field: keyof KeyMappingRef, value: string) =>
    setRows((current) =>
      current.map((mapping, i) => (i === index ? { ...mapping, [field]: value } : mapping)),
    );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit(
      rows
        .map((mapping) => ({ from: mapping.from.trim(), to: mapping.to.trim() }))
        .filter((mapping) => mapping.from !== "" || mapping.to !== ""),
    );
  };

  return (
    <form className="mapping" aria-label="Map storage origins" onSubmit={submit}>
      <p>
        Map each origin of the snapshot to an origin of this game, for example http://localhost:4317
        to http://127.0.0.1:4317. WGLauncher shows the mapping for confirmation before anything is
        written.
        {fromFile && " The file dialog opens again."}
      </p>
      {rows.map((mapping, index) => (
        // The rows have no identity of their own; they are only added at the end.
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are appended, never reordered
        <div key={index} className="mapping-row">
          <label>
            Snapshot origin
            <input
              type="text"
              value={mapping.from}
              onChange={(event) => edit(index, "from", event.target.value)}
              maxLength={2048}
            />
          </label>
          <label>
            Origin of this game
            <input
              type="text"
              value={mapping.to}
              onChange={(event) => edit(index, "to", event.target.value)}
              maxLength={2048}
            />
          </label>
        </div>
      ))}
      {rows.length < MAX_ROWS && (
        <button
          type="button"
          onClick={() => setRows((current) => [...current, { from: "", to: "" }])}
        >
          Add an origin
        </button>
      )}
      <button type="submit">Restore with this mapping</button>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}
