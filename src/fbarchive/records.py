"""Platform-agnostic records produced by importers and consumed by the indexer."""

from dataclasses import dataclass, field
from typing import Any


@dataclass
class Thread:
    """A conversation (Messenger thread, later WhatsApp chat, ...)."""

    id: str
    platform: str
    title: str
    box: str
    participants: list[str]
    is_group: bool


@dataclass
class Item:
    """One searchable thing: a message, post, comment, reaction, event, ..."""

    kind: str
    category: str
    ts: int | None  # unix ms
    title: str | None = None
    body: str | None = None
    meta: str | None = None  # secondary text, searchable with a low weight
    author: str | None = None
    thread: str | None = None
    extra: dict[str, Any] | None = None
    # (path relative to the export root, media type)
    media: list[tuple[str, str]] = field(default_factory=list)
    # Stable identity overriding the content hash (e.g. an event whose RSVP can change).
    key: str | None = None
