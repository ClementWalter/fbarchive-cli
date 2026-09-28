"""End-to-end tests of the HTTP API and static UI."""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from fbarchive.server import create_app


@pytest.fixture
def client(db_path: Path, tmp_path: Path) -> TestClient:
    return TestClient(create_app(db_path, tmp_path / "thumbs"))


def test_index_served(client):
    assert "fbarchive" in client.get("/").text


def test_search_endpoint(client):
    assert client.get("/api/search", params={"q": "lyon"}).json()["total"] == 1


def test_search_with_person_filter(client):
    paul = client.get("/api/people", params={"q": "Paul"}).json()[0]["id"]
    res = client.get("/api/search", params={"with": paul, "kind": "message"}).json()
    assert res["total"] == 2


def test_thread_endpoint(client):
    assert client.get("/api/thread/fb:skitrip_222").json()["title"] == "Ski trip"


def test_thread_messages_paging(client):
    msgs = client.get("/api/thread/fb:mariedupre_111/messages", params={"n": 2}).json()
    older = client.get(
        "/api/thread/fb:mariedupre_111/messages",
        params={"before_ts": msgs[0]["ts"], "before_id": msgs[0]["id"]},
    ).json()
    assert len(older) == 2


def test_unknown_thread_404(client):
    assert client.get("/api/thread/fb:nope").status_code == 404


def test_histogram_endpoint(client):
    assert sum(r["n"] for r in client.get("/api/histogram", params={"kind": "message"}).json()) == 6


def test_thumbnail_is_webp(client):
    media_id = client.get("/api/gallery").json()[0]["id"]
    assert (
        client.get(f"/thumb/{media_id}", params={"s": 160}).headers["content-type"] == "image/webp"
    )


def test_original_media_served(client):
    media_id = client.get("/api/gallery").json()[0]["id"]
    assert client.get(f"/media/{media_id}").headers["content-type"] == "image/jpeg"


def test_missing_media_404(client):
    assert client.get("/media/999999").status_code == 404
