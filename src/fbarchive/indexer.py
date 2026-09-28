"""Write importer records into the SQLite index, deduplicating across exports."""

import hashlib
import logging
import sqlite3
import time
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

import orjson

from fbarchive.records import Item, Thread

log = logging.getLogger(__name__)


def item_uid(platform: str, it: Item) -> str:
    """Content hash: the same message/post in two exports maps to the same row.

    Non-message items with a body ignore title/meta: Facebook lists the same post in
    several files with different headers ("wrote on X's profile" vs no title).
    """
    if it.key:
        return hashlib.blake2b(f"{platform}\x1f{it.key}".encode(), digest_size=12).hexdigest()
    parts = [platform, it.kind, it.thread, it.ts, it.author, it.body]
    if it.thread or not it.body:
        parts += [it.title, it.meta]
    key = "\x1f".join(str(x) for x in parts)
    # Two stickers/photos sent in the same ms differ only by their media.
    key += "\x1f" + "\x1f".join(p for p, _ in it.media)
    return hashlib.blake2b(key.encode(), digest_size=12).hexdigest()


@dataclass
class ImportStats:
    threads: int = 0
    items_seen: int = 0
    items_new: int = 0
    media_new: int = 0
    seconds: float = 0.0


class Indexer:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn
        self._people: dict[str, int] = {
            r["name"]: r["id"] for r in conn.execute("SELECT id, name FROM people")
        }

    def person_id(self, name: str | None) -> int | None:
        if not name:
            return None
        if (pid := self._people.get(name)) is None:
            cur = self.conn.execute("INSERT INTO people(name) VALUES (?)", (name,))
            pid = self._people[name] = cur.lastrowid
        return pid

    def source_id(self, platform: str, root: Path) -> int:
        self.conn.execute(
            "INSERT INTO sources(platform, root, imported_at) VALUES (?, ?, ?) "
            "ON CONFLICT(root) DO UPDATE SET imported_at = excluded.imported_at",
            (platform, str(root), int(time.time())),
        )
        return self.conn.execute("SELECT id FROM sources WHERE root = ?", (str(root),)).fetchone()[
            0
        ]

    def ingest(self, platform: str, root: Path, records: Iterable[Thread | Item]) -> ImportStats:
        """Insert all records of one export in a single transaction."""
        t0 = time.monotonic()
        stats = ImportStats()
        with self.conn:
            src = self.source_id(platform, root)
            for rec in records:
                if isinstance(rec, Thread):
                    self._add_thread(rec)
                    stats.threads += 1
                else:
                    stats.items_seen += 1
                    new_media = self._add_item(platform, src, rec)
                    if new_media is not None:
                        stats.items_new += 1
                        stats.media_new += new_media
        stats.seconds = time.monotonic() - t0
        return stats

    def _add_thread(self, t: Thread) -> None:
        self.conn.execute(
            "INSERT INTO threads(id, platform, title, box, is_group) VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET title = excluded.title, box = excluded.box",
            (t.id, t.platform, t.title, t.box, int(t.is_group)),
        )
        self.conn.executemany(
            "INSERT OR IGNORE INTO thread_people(thread_id, person_id) VALUES (?, ?)",
            [(t.id, self.person_id(p)) for p in t.participants],
        )

    def _add_item(self, platform: str, source_id: int, it: Item) -> int | None:
        """Return the number of media rows added, or None when the item already existed."""
        uid = item_uid(platform, it)
        extra = orjson.dumps(it.extra).decode() if it.extra else None
        if it.key:
            # Keyed items (events) take the latest export's RSVP and fill missing details.
            cur = self.conn.execute(
                "UPDATE items SET category = ?, extra = ?, body = coalesce(?, body), "
                "meta = coalesce(?, meta) WHERE uid = ?",
                (it.category, extra, it.body, it.meta, uid),
            )
            if cur.rowcount:
                return None
        cur = self.conn.execute(
            "INSERT OR IGNORE INTO items"
            "(uid, platform, kind, category, thread_id, author_id, ts, title, body, meta, extra) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                uid,
                platform,
                it.kind,
                it.category,
                it.thread,
                self.person_id(it.author),
                it.ts,
                it.title,
                it.body,
                it.meta,
                extra,
            ),
        )
        if not cur.rowcount:
            return None
        if it.media:
            self.conn.executemany(
                "INSERT OR IGNORE INTO media(item_id, source_id, path, mtype) VALUES (?, ?, ?, ?)",
                [(cur.lastrowid, source_id, p, mt) for p, mt in it.media],
            )
        return len(it.media)

    def finalize(self) -> None:
        """Recompute derived data (thread stats, owner, FTS) after one or more imports."""
        with self.conn:
            # Senders who left a group are missing from `participants`.
            self.conn.execute(
                "INSERT OR IGNORE INTO thread_people(thread_id, person_id) "
                "SELECT DISTINCT thread_id, author_id FROM items "
                "WHERE thread_id IS NOT NULL AND author_id IS NOT NULL"
            )
            self.conn.execute(
                "UPDATE threads SET first_ts = s.a, last_ts = s.b, n_items = s.n FROM ("
                "  SELECT thread_id, min(ts) a, max(ts) b, count(*) n FROM items"
                "  WHERE thread_id IS NOT NULL GROUP BY thread_id) s "
                "WHERE s.thread_id = threads.id"
            )
            # The owner is in the most threads; ties go to whoever authored non-thread
            # items (comments, posts), which only the owner does.
            self.conn.execute("UPDATE people SET is_me = 0")
            self.conn.execute(
                "UPDATE people SET is_me = 1 WHERE id = ("
                "  SELECT tp.person_id FROM thread_people tp GROUP BY tp.person_id"
                "  ORDER BY count(*) DESC, (SELECT count(*) FROM items"
                "    WHERE author_id = tp.person_id AND thread_id IS NULL) DESC LIMIT 1)"
            )
            self.conn.execute("INSERT INTO items_fts(items_fts) VALUES ('rebuild')")
        self.conn.execute("ANALYZE")
