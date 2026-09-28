"""Tests for the SQLite indexer: counts, dedup across exports, derived data."""

from pathlib import Path

from fbarchive.db import connect
from fbarchive.importers import facebook
from fbarchive.indexer import Indexer


def test_items_indexed(conn):
    # 6 messages + 1 post (duplicate listing merged) + 1 comment + 1 log
    assert conn.execute("SELECT count(*) FROM items").fetchone()[0] == 9


def test_duplicate_post_listings_are_merged(conn):
    assert conn.execute("SELECT count(*) FROM items WHERE kind = 'post'").fetchone()[0] == 1


def test_reimport_adds_nothing(db_path: Path, export: Path):
    conn = connect(db_path)
    ix = Indexer(conn)
    new = sum(
        ix.ingest(facebook.PLATFORM, root, facebook.iter_export(root)).items_new
        for root in facebook.find_exports(export)
    )
    assert new == 0


def test_owner_detected(conn):
    assert conn.execute("SELECT name FROM people WHERE is_me = 1").fetchone()[0] == "Zoé Exemple"


def test_thread_stats(conn):
    row = conn.execute("SELECT n_items FROM threads WHERE id = 'fb:mariedupre_111'").fetchone()
    assert row[0] == 4


def test_media_row_created(conn):
    assert conn.execute("SELECT mtype FROM media").fetchone()[0] == "photo"
