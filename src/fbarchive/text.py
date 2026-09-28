"""Text helpers: repair Facebook's double-encoded UTF-8 and build safe FTS5 queries."""

import re
from typing import Any

_WORD = re.compile(r"\w+", re.UNICODE)
# Explicit FTS5 syntax: the user knows what they're doing, pass it through.
_ADVANCED = re.compile(r'["*()^]|\b(AND|OR|NOT|NEAR)\b')


def fix_mojibake(s: str) -> str:
    """Re-decode a string whose UTF-8 bytes were exported as latin-1 code points.

    Facebook writes "é" as "\\u00c3\\u00a9"; strings that aren't valid under that
    reading (genuine non-latin-1 text) are returned unchanged.
    """
    if s.isascii():
        return s
    try:
        return s.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return s


def fix_tree(obj: Any) -> Any:
    """Apply `fix_mojibake` to every string (keys included) of a parsed JSON tree."""
    if isinstance(obj, str):
        return fix_mojibake(obj)
    if isinstance(obj, list):
        return [fix_tree(x) for x in obj]
    if isinstance(obj, dict):
        return {fix_mojibake(k): fix_tree(v) for k, v in obj.items()}
    return obj


def to_fts_query(q: str) -> str | None:
    """Turn free text into an FTS5 MATCH expression (AND of words, last one as prefix).

    The prefix on the last word makes search-as-you-type work.
    """
    q = q.strip()
    if not q:
        return None
    if _ADVANCED.search(q):
        return q
    words = _WORD.findall(q)
    if not words:
        return None
    quoted = [f'"{w}"' for w in words]
    quoted[-1] += "*"
    return " ".join(quoted)


def safe_fts_query(q: str) -> str | None:
    """Like `to_fts_query` but never emits raw syntax (fallback when parsing fails)."""
    words = _WORD.findall(q)
    if not words:
        return None
    return " ".join(f'"{w}"' for w in words)
