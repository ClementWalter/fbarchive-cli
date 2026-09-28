"""Fixtures: a tiny synthetic Facebook export, encoded the way Facebook encodes it."""

import json
from pathlib import Path

import pytest
from PIL import Image

from fbarchive.db import connect
from fbarchive.importers import facebook
from fbarchive.indexer import Indexer

ME = "Zoé Exemple"
MARIE = "Marie Dupré"
PAUL = "Paul Martin"


def fb_mojibake(obj):
    """Encode like Facebook: UTF-8 bytes stored as latin-1 code points."""
    if isinstance(obj, str):
        return obj.encode("utf-8").decode("latin-1")
    if isinstance(obj, list):
        return [fb_mojibake(x) for x in obj]
    if isinstance(obj, dict):
        return {k: fb_mojibake(v) for k, v in obj.items()}
    return obj


def write(root: Path, rel: str, data) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(fb_mojibake(data)))


# 2019-03-14 12:00:00 UTC
T0 = 1552564800000
HOUR = 3_600_000


@pytest.fixture
def export(tmp_path: Path) -> Path:
    root = tmp_path / "facebook-me-2026-09-10-AAAA"
    inbox = "your_facebook_activity/messages/inbox"
    write(
        root,
        f"{inbox}/mariedupre_111/message_1.json",
        {
            "participants": [{"name": MARIE}, {"name": ME}],
            "title": MARIE,
            "messages": [
                {"sender_name": MARIE, "timestamp_ms": T0 + 3 * HOUR, "content": "À demain !"},
                {
                    "sender_name": ME,
                    "timestamp_ms": T0 + 2 * HOUR,
                    "content": "On visite l'appartement à Lyon",
                    "reactions": [{"reaction": "❤", "actor": MARIE}],
                },
                {
                    "sender_name": MARIE,
                    "timestamp_ms": T0 + HOUR,
                    "photos": [{"uri": f"{inbox}/mariedupre_111/photos/1.jpg"}],
                },
                {"sender_name": ME, "timestamp_ms": T0, "content": "Salut Marie"},
            ],
        },
    )
    img = root / inbox / "mariedupre_111/photos/1.jpg"
    img.parent.mkdir(parents=True)
    Image.new("RGB", (800, 600), "red").save(img)
    write(
        root,
        f"{inbox}/skitrip_222/message_1.json",
        {
            "participants": [{"name": ME}, {"name": MARIE}, {"name": PAUL}],
            "title": "Ski trip",
            "messages": [
                {
                    "sender_name": PAUL,
                    "timestamp_ms": T0 + 10 * HOUR,
                    "content": "Qui vient au ski ?",
                },
                {"sender_name": ME, "timestamp_ms": T0 + 11 * HOUR, "content": "Moi, pour le ski"},
            ],
        },
    )
    posts = [
        {
            "timestamp": 1270000002,
            "data": [{"post": "Vacances à la mer, c'était génial"}],
            "title": f"{ME} shared a link.",
            "attachments": [{"data": [{"external_context": {"url": "http://example.com/x"}}]}],
        }
    ]
    write(
        root, "your_facebook_activity/posts/your_posts__check_ins__photos_and_videos_1.json", posts
    )
    write(
        root,
        "your_facebook_activity/posts/posts_on_other_pages_and_profiles.json",
        [
            {
                "timestamp": 1270000002,
                "label_values": [
                    {"label": "Message", "value": "Vacances à la mer, c'était génial"},
                    {"label": "Detected dialect", "value": "French (All)"},
                ],
            }
        ],
    )
    write(
        root,
        "your_facebook_activity/comments_and_reactions/comments.json",
        {
            "comments_v2": [
                {
                    "timestamp": 1299000099,
                    "data": [{"comment": {"comment": "Bravo Paul !", "author": ME}}],
                    "title": f"{ME} commented on Paul Martin's post.",
                }
            ]
        },
    )
    logs = root.parent / "facebook-me-2026-09-22-BBBB"
    write(
        logs,
        "data_logs/content/notifications_71/page_1.json",
        [
            {
                "timestamp": 1788000058,
                "label_values": [
                    {
                        "label": "What happened",
                        "value": "notification appartement",
                        "description": "The action or event that occurred",
                    }
                ],
            }
        ],
    )
    return tmp_path


@pytest.fixture
def db_path(export: Path, tmp_path: Path) -> Path:
    path = tmp_path / "idx" / "archive.db"
    conn = connect(path)
    ix = Indexer(conn)
    for root in facebook.find_exports(export):
        ix.ingest(facebook.PLATFORM, root, facebook.iter_export(root))
    ix.finalize()
    conn.close()
    return path


@pytest.fixture
def conn(db_path: Path):
    c = connect(db_path, readonly=True)
    yield c
    c.close()
