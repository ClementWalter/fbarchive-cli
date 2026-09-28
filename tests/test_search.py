"""Tests for the query layer."""

from datetime import datetime

import pytest

from fbarchive import search as s


def ids_of(res):
    return [it["body"] for it in res["items"]]


def test_accent_insensitive_match(conn):
    res = s.search(conn, s.Filters(q="a demain"))
    assert ids_of(res) == ["À demain !"]


def test_prefix_on_last_word(conn):
    res = s.search(conn, s.Filters(q="appart"))
    assert ids_of(res) == ["On visite l'appartement à Lyon"]


def test_logs_hidden_by_default(conn):
    assert s.search(conn, s.Filters(q="notification"))["total"] == 0


def test_logs_found_when_asked(conn):
    assert s.search(conn, s.Filters(q="notification", kinds=["log"]))["total"] == 1


def test_snippet_highlights_match(conn):
    res = s.search(conn, s.Filters(q="lyon"))
    assert f"{s.HL_START}Lyon{s.HL_END}" in res["items"][0]["snippet"]


def test_author_filter(conn):
    paul = s.resolve_people(conn, "Paul")
    res = s.search(conn, s.Filters(q="ski", author_ids=paul))
    assert ids_of(res) == ["Qui vient au ski ?"]


def test_with_filter_restricts_to_their_threads(conn):
    paul = s.resolve_people(conn, "Paul")
    assert s.search(conn, s.Filters(with_ids=paul, kinds=["message"]))["total"] == 2


def test_date_filter(conn):
    res = s.search(conn, s.Filters(kinds=["post"], until=s.parse_date("2010", end=True)))
    assert res["total"] == 1


def test_sort_old(conn):
    res = s.search(conn, s.Filters(thread_id="fb:mariedupre_111"), sort="old")
    assert res["items"][0]["body"] == "Salut Marie"


def test_invalid_fts_syntax_falls_back(conn):
    assert s.search(conn, s.Filters(q='"lyon'))["total"] == 1


def test_results_carry_media(conn):
    res = s.search(conn, s.Filters(thread_id="fb:mariedupre_111"), sort="old")
    assert [m["mtype"] for m in res["items"][1]["media"]] == ["photo"]


@pytest.mark.parametrize(
    ("value", "end", "expected"),
    [
        ("2019", False, datetime(2019, 1, 1)),
        ("2019-03", False, datetime(2019, 3, 1)),
        ("2019-03-14", False, datetime(2019, 3, 14)),
        ("2019", True, datetime(2020, 1, 1)),
        ("2019-12", True, datetime(2020, 1, 1)),
        ("2019-03-14", True, datetime(2019, 3, 15)),
    ],
)
def test_parse_date(value, end, expected):
    assert s.parse_date(value, end=end) == int(expected.timestamp() * 1000) - (1 if end else 0)


def test_histogram_months(conn):
    rows = s.histogram(conn, s.Filters(kinds=["message"]))
    assert sum(r["n"] for r in rows) == 6


def test_thread_window_latest(conn):
    msgs = s.thread_window(conn, "fb:mariedupre_111", n=2)
    assert [m["body"] for m in msgs] == ["On visite l'appartement à Lyon", "À demain !"]


def test_thread_window_around(conn):
    hit = s.search(conn, s.Filters(q="appartement"))["items"][0]
    msgs = s.thread_window(conn, "fb:mariedupre_111", around=hit["id"], n=4)
    assert [m["body"] for m in msgs] == [None, "On visite l'appartement à Lyon", "À demain !"]


def test_thread_window_before_cursor(conn):
    latest = s.thread_window(conn, "fb:mariedupre_111", n=1)[0]
    older = s.thread_window(conn, "fb:mariedupre_111", before=(latest["ts"], latest["id"]), n=10)
    assert len(older) == 3


def test_person_profile_threads(conn):
    marie = s.resolve_people(conn, "Marie")[0]
    assert len(s.person_profile(conn, marie)["threads"]) == 2


def test_gallery_lists_photo(conn):
    assert [g["mtype"] for g in s.gallery(conn, s.Filters())] == ["photo"]
