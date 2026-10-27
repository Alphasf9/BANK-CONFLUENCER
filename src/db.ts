/**
 * SQLite connection + schema.
 *
 * Money is stored as INTEGER minor units (paise/cents) to avoid float errors.
 * Integrity is enforced by the database itself (CHECK, FOREIGN KEY, UNIQUE),
 * not only by application code.
 */
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

export type DB = Database.Database;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  balance     INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS transactions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    INTEGER NOT NULL REFERENCES accounts(id),
  type          TEXT    NOT NULL CHECK (type IN ('credit', 'debit')),
  amount        INTEGER NOT NULL CHECK (amount > 0),
  reference_id  TEXT    NOT NULL CHECK (length(trim(reference_id)) > 0),
  description   TEXT,
  balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
  transfer_id   TEXT,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (account_id, reference_id)
);

CREATE INDEX IF NOT EXISTS idx_tx_account_created ON transactions (account_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_tx_transfer ON transactions (transfer_id);
`;

export function openDb(file: string): DB {
  if (file !== ":memory:") {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  return db;
}
