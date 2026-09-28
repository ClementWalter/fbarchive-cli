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
    events = EventMerger()
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
            elif rel.removesuffix(".json") in EVENT_FILES:
                events.add_file(data, EVENT_FILES[rel.removesuffix(".json")])
            elif rel.removesuffix(".json") == VISITED_FILE:
                # Mixed file: event pages you opened (with their description) and groups.
                for rec in data if isinstance(data, list) else []:
                    if not events.add_visited(rec):
                        yield record_to_item(rec, "activity", VISITED_FILE)
            else:
                yield from parse_generic_file(data, rel)
    yield from events.items()


EVENTS_DIR = "your_facebook_activity/events/"
# File -> the RSVP it implies. `your_event_responses` holds one list per RSVP.
EVENT_FILES = {
    f"{EVENTS_DIR}your_event_responses": None,
    f"{EVENTS_DIR}event_invitations": "invited",
    f"{EVENTS_DIR}your_events": "hosted",
    f"{EVENTS_DIR}events_you_hosted": "hosted",
}
RSVP_KEYS = {
    "events_joined": "going",
    "events_interested": "interested",
    "events_declined": "declined",
}
# When an event shows up in several files, the most committed answer wins.
RSVP_RANK = {"visited": -1, "invited": 0, "declined": 1, "interested": 2, "going": 3, "hosted": 4}
VISITED_FILE = "logged_information/interactions/groups_and_events_you've_visited"
EVENT_URL = re.compile(r"facebook\.com/events/(\d+)")


def _event_from_labels(label_values: list) -> dict[str, Any]:
    """Flatten a label/value tree (`events_you_hosted`, visited events) into the event shape."""
    fields = {
        "Name": "name",
        "Start time": "start_timestamp",
        "End time": "end_timestamp",
        "Description": "description",
        "URL": "url",
    }
    out: dict[str, Any] = {}

    def walk(node: Any, section: str | None) -> None:
        if isinstance(node, list):
            for x in node:
                walk(x, section)
        elif isinstance(node, dict):
            section = node.get("title") or section
            key = fields.get(node.get("label", ""))
            # Top level or the "Event" section: "Event host" also has a Name (the host's).
            if key and section in (None, "Event") and key not in out:
                out[key] = node.get("timestamp_value") or node.get("href") or node.get("value")
            walk(node.get("dict"), section)

    walk(label_values, None)
    return out


class EventMerger:
    """Folds the event files into one record per (name, start), keeping RSVP and place."""

    def __init__(self) -> None:
        self._events: dict[tuple[str, int], dict[str, Any]] = {}

    def add_file(self, data: Any, rsvp: str | None) -> None:
        body = next(iter(data.values()), None) if isinstance(data, dict) else data
        if isinstance(body, dict):
            for key, events in body.items():
                self._add_many(events, RSVP_KEYS.get(key, "invited"))
        else:
            self._add_many(body, rsvp or "invited")

    def add_visited(self, rec: Any) -> bool:
        """Merge a visited event page; False when the record isn't an event (e.g. a group)."""
        if not isinstance(rec, dict) or "label_values" not in rec:
            return False
        ev = _event_from_labels(rec["label_values"])
        if not ev.get("name") or "start_timestamp" not in ev:
            return False
        self._add_many([ev], "visited")
        return True

    def _add_many(self, events: Any, rsvp: str) -> None:
        for ev in events if isinstance(events, list) else []:
            if isinstance(ev, dict) and "label_values" in ev:
                ev = _event_from_labels(ev["label_values"])
            if not isinstance(ev, dict) or not ev.get("name"):
                continue
            key = (ev["name"], ev.get("start_timestamp") or 0)
            cur = self._events.setdefault(key, {"name": ev["name"], "rsvp": rsvp})
            if RSVP_RANK[rsvp] > RSVP_RANK[cur["rsvp"]]:
                cur["rsvp"] = rsvp
            for field in (
                "start_timestamp",
                "end_timestamp",
                "description",
                "place",
                "response_time",
                "create_timestamp",
                "url",
            ):
                if ev.get(field) and not cur.get(field):
                    cur[field] = ev[field]

    def items(self) -> Iterator[Item]:
        for ev in self._events.values():
            place = ev.get("place") or {}
            coord = place.get("coordinate") or {}
            info = {
                "start": to_ms(ev.get("start_timestamp")),
                "end": to_ms(ev.get("end_timestamp")),
                "rsvp": ev["rsvp"],
                "responded": to_ms(ev.get("response_time")),
                "place": place.get("name"),
                "address": place.get("address") or None,
                "lat": coord.get("latitude"),
                "lon": coord.get("longitude"),
                "url": ev.get("url"),
                # Links shared in Messenger carry this id: the key to who sent the event.
                "fbid": m.group(1) if (m := EVENT_URL.search(ev.get("url") or "")) else None,
            }
            where = " · ".join(dict.fromkeys(v for v in (info["place"], info["address"]) if v))
            yield Item(
                kind="event",
                category=f"{EVENTS_DIR}{ev['rsvp']}",
                ts=info["start"],
                title=ev["name"],
                body=ev.get("description") or None,
                meta=where or None,
                extra={"event": {k: v for k, v in info.items() if v is not None}},
                # Identity is the event itself, so a changed RSVP in a later export merges.
                key=f"event\x1f{ev['name']}\x1f{ev.get('start_timestamp') or 0}",
            )


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
