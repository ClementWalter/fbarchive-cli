"""Parse a Facebook "Download your information" JSON export into generic records.

Messenger threads get a dedicated parser (threads, senders, attachments, reactions).
Every other JSON file goes through a generic walker: any dict carrying a timestamp
is one record, its free text becomes the body and its `uri` leaves become media.
"""

import logging
import re
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import orjson

from fbarchive.records import Item, Thread
from fbarchive.text import fix_tree

log = logging.getLogger(__name__)

PLATFORM = "facebook"
# Cloud sync clients may add " (1)" copies of a file; they're still thread files.
MESSAGE_FILE = re.compile(r"(^|/)messages/([^/]+)/([^/]+)/message_\d+( \(\d+\))?\.json$")

TS_KEYS = ("timestamp_ms", "timestamp", "creation_timestamp", "start_timestamp")
# Keys whose string values are the "real" content of a record.
MAIN_KEYS = {"post", "comment", "description", "text", "message", "content", "caption"}
MAIN_LABELS = {"message", "text", "comment", "post", "description", "caption", "name", "title"}
AUTHOR_KEYS = ("author", "actor", "sender_name")
LINK_KEYS = {"url", "link", "href"}
# Machine noise that only pollutes search.
SKIP_KEYS = {"uri", "upload_ip", "ip", "thread_path", "title", "fbid", "id", "cookie"}
SKIP_VALUES = {"", "True", "False", "true", "false", "None"}

# First matching prefix (relative to the export root) wins.
KIND_RULES: tuple[tuple[str, str], ...] = (
    ("your_facebook_activity/comments_and_reactions/likes_and_reactions", "reaction"),
    ("your_facebook_activity/comments_and_reactions/", "comment"),
    ("your_facebook_activity/posts/album/", "photo"),
    ("your_facebook_activity/posts/your_uncategorized_photos", "photo"),
    ("your_facebook_activity/posts/your_videos", "video"),
    ("your_facebook_activity/posts/", "post"),
    ("your_facebook_activity/groups/your_comments_in_groups", "comment"),
    ("your_facebook_activity/groups/group_posts", "post"),
    ("your_facebook_activity/groups/", "group"),
    ("your_facebook_activity/events/", "event"),
    ("your_facebook_activity/saved_items_and_collections/", "saved"),
    ("your_facebook_activity/stories/", "post"),
    ("your_facebook_activity/activity_you're_tagged_in/", "post"),
    ("logged_information/search/", "search"),
    ("connections/", "friend"),
    ("data_logs/", "log"),
)

MEDIA_EXT = {
    "photo": {".jpg", ".jpeg", ".png", ".webp", ".heic"},
    "gif": {".gif"},
    "video": {".mp4", ".mov", ".wmv", ".webm"},
    "audio": {".aac", ".m4a", ".mp3", ".wav", ".ogg"},
}


def kind_for(rel: str) -> str:
    for prefix, kind in KIND_RULES:
        if rel.startswith(prefix):
            return kind
    return "activity"


def media_type(uri: str) -> str:
    ext = Path(uri).suffix.lower()
    for mtype, exts in MEDIA_EXT.items():
        if ext in exts:
            return mtype
    return "file"


def to_ms(value: Any) -> int | None:
    """Normalise seconds/ms timestamps; FB uses tiny placeholders (e.g. 1) for unknown dates."""
    if not isinstance(value, int | float) or value < 100_000_000:
        return None
    return int(value if value > 100_000_000_000 else value * 1000)


def find_exports(path: Path) -> list[Path]:
    """Return export roots under `path` (itself, or its `facebook-*` children)."""
    children = sorted(p for p in path.iterdir() if p.is_dir() and p.name.startswith("facebook-"))
    return children or [path]


def iter_export(root: Path, workers: int = 16) -> Iterator[Thread | Item]:
    """Yield every thread and item of one export root."""
    paths = sorted(p for p in root.rglob("*.json") if p.is_file())
    # Reads run in a pool: on network/cloud mounts latency dominates, not parsing.
    with ThreadPoolExecutor(workers) as pool:
        for path, raw in zip(paths, pool.map(Path.read_bytes, paths), strict=True):
            rel = path.relative_to(root).as_posix()
            try:
                data = fix_tree(orjson.loads(raw))
            except orjson.JSONDecodeError:
                log.warning("skipping unparsable %s", rel)
                continue
            if m := MESSAGE_FILE.search(rel):
                yield from parse_thread_file(data, box=m.group(2), folder=m.group(3))
            else:
                yield from parse_generic_file(data, rel)


def parse_thread_file(data: dict, box: str, folder: str) -> Iterator[Thread | Item]:
    """One `message_N.json` file: the thread header, then its messages."""
    # The folder name is stable across exports even if the thread moves inbox -> archived.
    thread_id = f"fb:{folder}"
    participants = [p["name"] for p in data.get("participants", []) if p.get("name")]
    yield Thread(
        id=thread_id,
        platform=PLATFORM,
        title=data.get("title") or folder,
        box=box,
        participants=participants,
        is_group=len(participants) > 2 or "group" in str(data.get("thread_type", "")).lower(),
    )
    for msg in data.get("messages", []):
        yield parse_message(msg, thread_id, box)


def parse_message(msg: dict, thread_id: str, box: str) -> Item:
    media: list[tuple[str, str]] = []
    for key in ("photos", "videos", "gifs", "audio_files", "files"):
        for att in msg.get(key) or []:
            if uri := att.get("uri"):
                media.append((uri, "audio" if key == "audio_files" else media_type(uri)))
    if (sticker := msg.get("sticker")) and sticker.get("uri"):
        media.append((sticker["uri"], "sticker"))

    extra: dict[str, Any] = {}
    meta: list[str] = []
    if reactions := msg.get("reactions"):
        extra["reactions"] = [{"r": r.get("reaction"), "by": r.get("actor")} for r in reactions]
    if share := msg.get("share"):
        extra["share"] = share
        meta += [v for v in (share.get("share_text"), share.get("link")) if v]
    if "call_duration" in msg:
        extra["call_duration"] = msg["call_duration"]
    if msg.get("is_unsent"):
        extra["unsent"] = True

    return Item(
        kind="message",
        category=box,
        ts=to_ms(msg.get("timestamp_ms")),
        body=msg.get("content"),
        meta=" · ".join(meta) or None,
        author=msg.get("sender_name"),
        thread=thread_id,
        extra=extra or None,
        media=media,
    )


def find_records(obj: Any) -> Iterator[dict]:
    """Outermost dicts carrying a timestamp; nested ones belong to their parent record."""
    if isinstance(obj, dict):
        if any(k in obj for k in TS_KEYS):
            yield obj
            return
        for v in obj.values():
            yield from find_records(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from find_records(v)


def parse_generic_file(data: Any, rel: str) -> Iterator[Item]:
    kind = kind_for(rel)
    category = rel.removesuffix(".json")
    for rec in find_records(data):
        yield record_to_item(rec, kind, category)


def record_to_item(rec: dict, kind: str, category: str) -> Item:
    ts = next((to_ms(rec[k]) for k in TS_KEYS if k in rec), None)
    title = next((rec[k] for k in ("title", "name") if isinstance(rec.get(k), str)), None)
    acc = _Collected()
    acc.walk(rec, parent_key=None)
    body = "\n".join(_dedup(acc.main)) or None
    meta = [m for m in _dedup(acc.meta) if m != title and m != body]
    extra = {"links": _dedup(acc.links)} if acc.links else None
    return Item(
        kind=kind,
        category=category,
        ts=ts,
        title=title,
        body=body,
        meta=" · ".join(meta) or None,
        author=acc.author,
        extra=extra,
        media=[(u, media_type(u)) for u in _dedup(acc.media)],
    )


class _Collected:
    """Accumulates the string leaves of one record by role."""

    def __init__(self) -> None:
        self.main: list[str] = []
        self.meta: list[str] = []
        self.links: list[str] = []
        self.media: list[str] = []
        self.author: str | None = None

    def walk(self, obj: Any, parent_key: str | None) -> None:
        if isinstance(obj, dict):
            if "label" in obj and isinstance(obj.get("value"), str):
                self._label(obj["label"], obj["value"])
            for k, v in obj.items():
                # A label's `description` documents the field, it isn't user content.
                if "label" in obj and k in ("label", "value", "description"):
                    continue
                self.walk(v, k)
        elif isinstance(obj, list):
            for v in obj:
                self.walk(v, parent_key)
        elif isinstance(obj, str):
            self._leaf(parent_key, obj)

    def _label(self, label: str, value: str) -> None:
        if value in SKIP_VALUES:
            return
        if label.lower() in MAIN_LABELS:
            self.main.append(value)
        elif value.startswith("http"):
            self.links.append(value)
        else:
            self.meta.append(f"{label}: {value}")

    def _leaf(self, key: str | None, value: str) -> None:
        if value in SKIP_VALUES:
            return
        if key == "uri":
            (self.links if value.startswith("http") else self.media).append(value)
        elif key in LINK_KEYS:
            self.links.append(value)
        elif key in AUTHOR_KEYS:
            self.author = self.author or value
        elif key in MAIN_KEYS:
            self.main.append(value)
        elif key not in SKIP_KEYS:
            self.meta.append(value)


def _dedup(xs: list[str]) -> list[str]:
    return list(dict.fromkeys(xs))
