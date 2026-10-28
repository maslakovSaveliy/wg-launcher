// Add a game by URL (architecture.md section 12). The pasted address is trimmed visibly (the field shows what is
// sent); main checks it with the entry-URL rule, which does not trim. The same address twice is confirmed in a
// native dialog by main.

import { type FormEvent, useState } from "react";
import { bridge } from "../api.js";

export function AddGame({ onAdded }: { onAdded: () => Promise<void> }) {
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = url.trim();
    setUrl(trimmed);
    const trimmedTitle = title.trim();
    setBusy(true);
    try {
      const result = await bridge().addGame(
        trimmedTitle === "" ? { url: trimmed } : { url: trimmed, title: trimmedTitle },
      );
      if (result.ok) {
        setUrl("");
        setTitle("");
        setMessage({ error: false, text: `Added "${result.data.title}".` });
        await onAdded();
      } else {
        setMessage({ error: result.code !== "CANCELLED", text: result.message });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} aria-label="Add a game">
      <label>
        Game address
        <input
          type="text"
          name="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://"
          spellCheck={false}
          autoComplete="off"
          required
        />
      </label>
      <label>
        Title (optional)
        <input
          type="text"
          name="title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={400}
        />
      </label>
      <button type="submit" disabled={busy}>
        Add
      </button>
      {message && (
        <p role={message.error ? "alert" : "status"} className="add-message">
          {message.text}
        </p>
      )}
    </form>
  );
}
