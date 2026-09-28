"""Tests for the Facebook export parser."""

from pathlib import Path

import pytest

from fbarchive.importers import facebook
from fbarchive.records import Item, Thread


@pytest.mark.parametrize(
    ("rel", "kind"),
    [
        ("your_facebook_activity/comments_and_reactions/likes_and_reactions_1.json", "reaction"),
        ("your_facebook_activity/comments_and_reactions/comments.json", "comment"),
        ("your_facebook_activity/posts/album/3.json", "photo"),
        ("your_facebook_activity/posts/your_posts_1.json", "post"),
        ("your_facebook_activity/groups/your_comments_in_groups.json", "comment"),
        ("your_facebook_activity/events/your_events.json", "event"),
        ("data_logs/content/x/page_1.json", "log"),
        ("preferences/feed/whatever.json", "activity"),
    ],
)
def test_kind_for(rel, kind):
    assert facebook.kind_for(rel) == kind


@pytest.mark.parametrize(
    ("value", "ms"),
    [(1270000002, 1270000002000), (1552564800000, 1552564800000), (1, None), ("x", None)],
)
def test_to_ms(value, ms):
    assert facebook.to_ms(value) == ms


@pytest.mark.parametrize(
    ("rel", "matches"),
    [
        ("your_facebook_activity/messages/inbox/bob_1/message_1.json", True),
        ("your_facebook_activity/messages/inbox/bob_1/message_12.json", True),
        ("your_facebook_activity/messages/inbox/bob_1/message_1 (1).json", True),
        ("your_facebook_activity/messages/messaging_settings.json", False),
    ],
)
def test_message_file_pattern(rel, matches):
    assert bool(facebook.MESSAGE_FILE.search(rel)) is matches


def test_find_exports_lists_facebook_children(export: Path):
    assert [p.name for p in facebook.find_exports(export)] == [
        "facebook-me-2026-09-10-AAAA",
        "facebook-me-2026-09-22-BBBB",
    ]


@pytest.fixture
def records(export: Path) -> list:
    return list(facebook.iter_export(export / "facebook-me-2026-09-10-AAAA"))


def test_thread_participants_are_decoded(records):
    thread = next(r for r in records if isinstance(r, Thread) and r.id == "fb:mariedupre_111")
    assert thread.participants == ["Marie Dupré", "Zoé Exemple"]


def test_group_thread_detected(records):
    thread = next(r for r in records if isinstance(r, Thread) and r.id == "fb:skitrip_222")
    assert thread.is_group is True


def test_message_photo_is_media(records):
    photo_msg = next(r for r in records if isinstance(r, Item) and r.media)
    assert photo_msg.media == [
        ("your_facebook_activity/messages/inbox/mariedupre_111/photos/1.jpg", "photo")
    ]


def test_message_reactions_kept(records):
    msg = next(r for r in records if isinstance(r, Item) and r.extra and "reactions" in r.extra)
    assert msg.extra["reactions"] == [{"r": "❤", "by": "Marie Dupré"}]


def test_generic_post_body(records):
    post = next(
        r for r in records if isinstance(r, Item) and r.title == "Zoé Exemple shared a link."
    )
    assert post.body == "Vacances à la mer, c'était génial"


def test_generic_post_links(records):
    post = next(
        r for r in records if isinstance(r, Item) and r.title == "Zoé Exemple shared a link."
    )
    assert post.extra == {"links": ["http://example.com/x"]}


def test_label_values_main_text(records):
    post = next(r for r in records if isinstance(r, Item) and r.title is None and r.kind == "post")
    assert post.body == "Vacances à la mer, c'était génial"


def test_label_values_secondary_text_goes_to_meta(records):
    post = next(r for r in records if isinstance(r, Item) and r.title is None and r.kind == "post")
    assert post.meta == "Detected dialect: French (All)"


def test_comment_author(records):
    comment = next(r for r in records if isinstance(r, Item) and r.kind == "comment")
    assert comment.author == "Zoé Exemple"


def test_label_description_is_not_content(export: Path):
    (log,) = facebook.iter_export(export / "facebook-me-2026-09-22-BBBB")
    assert log.body is None


def test_label_value_kept_as_meta(export: Path):
    (log,) = facebook.iter_export(export / "facebook-me-2026-09-22-BBBB")
    assert log.meta == "What happened: notification appartement"
