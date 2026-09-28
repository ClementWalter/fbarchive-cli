"""Tests for event parsing: one record per event, with RSVP, place and details merged."""

from pathlib import Path

import pytest
from conftest import write

from fbarchive import search as s
from fbarchive.db import connect
from fbarchive.importers import facebook
from fbarchive.indexer import Indexer

EV = "your_facebook_activity/events"
PARTY = {"name": "Soirée Exemple", "start_timestamp": 1609502400, "end_timestamp": 1609525800}
SKI = {"name": "Semaine ski", "start_timestamp": 1300000000, "end_timestamp": 1300653400}


def responses(joined, declined=()):
    return {
        "event_responses_v2": {
            "events_joined": list(joined),
            "events_declined": list(declined),
            "events_interested": [],
        }
    }


@pytest.fixture
def events_root(tmp_path: Path) -> Path:
    root = tmp_path / "facebook-ev"
    write(root, f"{EV}/your_event_responses.json", responses([PARTY], [SKI]))
    write(root, f"{EV}/event_invitations.json", {"events_invited_v2": [PARTY, SKI]})
    place = {"name": "Chez moi", "address": "1 rue Exemple", "coordinate": {"latitude": 48.85}}
    write(
        root,
        f"{EV}/your_events.json",
        {"your_events_v2": [{**PARTY, "place": place, "description": "Description de la soirée"}]},
    )
    hosted_labels = [
        {
            "title": "Event",
            "dict": [
                {
                    "dict": [
                        {"label": "Name", "value": "Anniversaire"},
                        {"label": "Start time", "timestamp_value": 1700000000},
                        {"label": "URL", "href": "https://www.facebook.com/events/1/"},
                    ]
                }
            ],
        },
        {"title": "Event host", "dict": [{"dict": [{"label": "Name", "value": "Zoé"}]}]},
    ]
    write(root, f"{EV}/events_you_hosted.json", [{"timestamp": 1, "label_values": hosted_labels}])
    return root


@pytest.fixture
def events(events_root: Path) -> dict:
    return {it.title: it for it in facebook.iter_export(events_root)}


def test_one_record_per_event(events):
    assert sorted(events) == ["Anniversaire", "Semaine ski", "Soirée Exemple"]


def test_hosting_beats_going(events):
    assert events["Soirée Exemple"].extra["event"]["rsvp"] == "hosted"


def test_declined_beats_invited(events):
    assert events["Semaine ski"].extra["event"]["rsvp"] == "declined"


def test_description_becomes_body(events):
    assert events["Soirée Exemple"].body == "Description de la soirée"


def test_place_is_searchable_meta(events):
    assert events["Soirée Exemple"].meta == "Chez moi · 1 rue Exemple"


def test_start_is_the_item_date(events):
    assert events["Semaine ski"].ts == 1300000000000


def test_labelled_hosted_event_name_is_not_the_host(events):
    assert "Anniversaire" in events


def test_labelled_hosted_event_url(events):
    assert events["Anniversaire"].extra["event"]["url"] == "https://www.facebook.com/events/1/"


def test_reimport_with_new_rsvp_updates_in_place(events_root: Path, tmp_path: Path):
    conn = connect(tmp_path / "ev.db")
    ix = Indexer(conn)
    ix.ingest(facebook.PLATFORM, events_root, facebook.iter_export(events_root))
    write(events_root, f"{EV}/your_event_responses.json", responses([PARTY, SKI]))
    ix.ingest(facebook.PLATFORM, events_root, facebook.iter_export(events_root))
    ix.finalize()
    rows = s.search(conn, s.Filters(q="Semaine ski", kinds=["event"]))["items"]
    assert [r["extra"]["event"]["rsvp"] for r in rows] == ["going"]


def test_category_filter_by_rsvp(events_root: Path, tmp_path: Path):
    conn = connect(tmp_path / "ev.db")
    ix = Indexer(conn)
    ix.ingest(facebook.PLATFORM, events_root, facebook.iter_export(events_root))
    ix.finalize()
    res = s.search(conn, s.Filters(kinds=["event"], category=f"{EV}/declined"))
    assert [r["title"] for r in res["items"]] == ["Semaine ski"]
