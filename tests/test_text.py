"""Tests for mojibake repair and FTS query building."""

import pytest

from fbarchive.text import fix_mojibake, fix_tree, safe_fts_query, to_fts_query


@pytest.mark.parametrize(
    ("raw", "fixed"),
    [
        ("ZoÃ©", "Zoé"),
        ("Ã\xa0 demain", "à demain"),
        ("plain ascii", "plain ascii"),
        ("déjà propre", "déjà propre"),
        ("日本語", "日本語"),
        ("â\x9d¤", "❤"),
    ],
)
def test_fix_mojibake(raw, fixed):
    assert fix_mojibake(raw) == fixed


def test_fix_tree_repairs_nested_values_and_keys():
    assert fix_tree({"ClÃ©": [{"x": "Ã©tÃ©"}, 3]}) == {"Clé": [{"x": "été"}, 3]}


@pytest.mark.parametrize(
    ("q", "expected"),
    [
        ("appart", '"appart"*'),
        ("appart lyon", '"appart" "lyon"*'),
        ("l'appart", '"l" "appart"*'),
        ('"exact phrase"', '"exact phrase"'),
        ("ski OR velo", "ski OR velo"),
        ("   ", None),
        ("!!!", None),
    ],
)
def test_to_fts_query(q, expected):
    assert to_fts_query(q) == expected


def test_safe_fts_query_drops_syntax():
    assert safe_fts_query('"unbalanced (NEAR') == '"unbalanced" "NEAR"'
