-- Schema v1: architecture.md section 7, verbatim. migrate.test.ts compares this file with that block.
-- The per-connection pragmas (journal_mode, foreign_keys, synchronous) are set by database.ts when it opens the file.
CREATE TABLE device (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);           -- one row, random UUIDv7
CREATE TABLE games (
  id TEXT PRIMARY KEY,                -- UUIDv7, independent of the URL
  url TEXT NOT NULL, title TEXT NOT NULL, cover_path TEXT,
  support_mode TEXT NOT NULL DEFAULT 'by-link' CHECK (support_mode = 'by-link'),
  base_revision_id TEXT,              -- revision the partition's data descends from (rule in save-transfer.md)
  needs_recovery INTEGER NOT NULL DEFAULT 0,
  last_launched_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE window_state (
  game_id TEXT PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
  x INTEGER, y INTEGER, width INTEGER NOT NULL, height INTEGER NOT NULL, display_id TEXT,
  maximized INTEGER NOT NULL, fullscreen INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE play_sessions (
  id INTEGER PRIMARY KEY, game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL, ended_at INTEGER, active_ms INTEGER NOT NULL DEFAULT 0, checkpoint_at INTEGER NOT NULL);
CREATE TABLE storage_targets (        -- no foreign key: kept for orphaned data
  game_id TEXT NOT NULL, top_origin TEXT NOT NULL, frame_origin TEXT NOT NULL,
  in_export INTEGER NOT NULL DEFAULT 0, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (game_id, top_origin, frame_origin));
CREATE TABLE snapshots (              -- no foreign key: snapshots outlive the card
  revision_id TEXT PRIMARY KEY, game_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('export', 'backup', 'imported')),
  manifest_game_id TEXT NOT NULL, parent_revision_id TEXT, created_at TEXT NOT NULL, device_id TEXT NOT NULL,
  exporter_id TEXT NOT NULL, exporter_version TEXT NOT NULL, adapter_id TEXT, adapter_version TEXT,
  content_hash TEXT NOT NULL, size_bytes INTEGER NOT NULL, path TEXT NOT NULL,
  flush_state TEXT NOT NULL CHECK (flush_state IN ('confirmed', 'unconfirmed')),
  verified_at INTEGER, verified_exporter_version TEXT, added_at INTEGER NOT NULL);
CREATE TABLE restore_journal (
  id TEXT PRIMARY KEY, game_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('import', 'delete-saves')),
  revision_id TEXT, backup_revision_id TEXT, step TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'rolling-back', 'done', 'failed')),
  started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE storage_checks (game_id TEXT PRIMARY KEY, checked_at INTEGER NOT NULL, has_data INTEGER NOT NULL);
CREATE TABLE orphans (game_id TEXT PRIMARY KEY, url TEXT NOT NULL, title TEXT NOT NULL, removed_at INTEGER NOT NULL);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);                -- JSON, allowlisted keys
CREATE INDEX snapshots_by_game ON snapshots (game_id, added_at);
CREATE INDEX play_sessions_by_game ON play_sessions (game_id, started_at);
