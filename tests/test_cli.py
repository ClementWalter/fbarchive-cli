"""End-to-end tests of the CLI: import an export, then query it."""

import json
from pathlib import Path

import pytest
from click.testing import CliRunner

from fbarchive.cli import main


@pytest.fixture
def cli_db(export: Path, tmp_path: Path) -> Path:
    db = tmp_path / "cli.db"
    result = CliRunner().invoke(main, ["--db", str(db), "import", str(export)])
    assert result.exit_code == 0, result.output
    return db


def run(db: Path, *args: str):
    return CliRunner().invoke(main, ["--db", str(db), *args])


def test_search_json(cli_db):
    out = json.loads(run(cli_db, "search", "lyon", "--json").output)
    assert out["items"][0]["body"] == "On visite l'appartement à Lyon"


def test_search_with_person(cli_db):
    out = json.loads(run(cli_db, "search", "--with", "Paul", "-k", "message", "--json").output)
    assert out["total"] == 2


def test_unknown_person_is_an_error(cli_db):
    assert run(cli_db, "search", "--with", "Nobody").exit_code == 2


def test_thread_text_output(cli_db):
    assert "Qui vient au ski ?" in run(cli_db, "thread", "fb:skitrip_222").output


def test_people_lists_owner_first(cli_db):
    assert "Zoé Exemple" in run(cli_db, "people", "-n", "1").output


def test_serve_without_index_fails(tmp_path):
    assert run(tmp_path / "missing.db", "serve").exit_code == 1
