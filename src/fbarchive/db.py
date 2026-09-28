"""SQLite schema and connection helpers for the archive index."""

import os
import sqlite3
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS sources(
  id INTEGER PRIMARY KEY,
  platform TEXT NOT NULL,
  root TEXT NOT NULL UNIQUE,
  imported_at INTEGER
);
CREATE TABLE IF NOT EXISTS people(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  is_me INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS threads(
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  title TEXT,
  box TEXT,
  is_group INTEGER NOT NULL DEFAULT 0,
  first_ts INTEGER,
  last_ts INTEGER,
  n_items INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS thread_people(
  thread_id TEXT NOT NULL,
  person_id INTEGER NOT NULL,
  PRIMARY KEY(thread_id, person_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS items(
  id INTEGER PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL,
  kind TEXT NOT NULL,
  category TEXT,
  thread_id TEXT,
  author_id INTEGER,
  ts INTEGER,
  title TEXT,
  body TEXT,
  meta TEXT,
  extra TEXT
);
CREATE INDEX IF NOT EXISTS items_ts ON items(ts);
CREATE INDEX IF NOT EXISTS items_thread_ts ON items(thread_id, ts, id);
CREATE INDEX IF NOT EXISTS items_author_ts ON items(author_id, ts);
CREATE INDEX IF NOT EXISTS items_kind_ts ON items(kind, ts);
CREATE TABLE IF NOT EXISTS media(
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL,
  source_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  mtype TEXT NOT NULL,
  UNIQUE(item_id, path)
);
CREATE INDEX IF NOT EXISTS media_mtype ON media(mtype, item_id);
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  title, body, meta,
  content='items', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2',
  prefix='2 3'
);
"""


def default_db_path() -> Path:
    if env := os.environ.get("FBARCHIVE_DB"):
        return Path(env)
    base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))
    return base / "fbarchive" / "archive.db"


def connect(path: Path | str, readonly: bool = False) -> sqlite3.Connection:
    path = Path(path)
    if readonly:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, check_same_thread=False)
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(path, check_same_thread=False)
        conn.executescript(SCHEMA)
        conn.execute("PRAGMA journal_mode=WAL")
    conn.row_factory = sqlite3.Row
    # Large page cache + mmap keep searches in memory after the first hit.
    conn.execute("PRAGMA cache_size=-200000")
    conn.execute("PRAGMA mmap_size=1073741824")
    return conn
