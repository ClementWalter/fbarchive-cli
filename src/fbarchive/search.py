"""Query layer shared by the CLI and the web API."""

import sqlite3
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

import orjson

from fbarchive.text import safe_fts_query, to_fts_query

# Meta's own telemetry: only shown when explicitly asked for.
HIDDEN_BY_DEFAULT = ("log",)
# Snippet markers are control chars so callers can HTML-escape before highlighting.
HL_START, HL_END = "\x02", "\x03"


def parse_date(s: str | None, end: bool = False) -> int | None:
    """'2019', '2019-03' or '2019-03-14' -> unix ms at the start (or end) of that period."""
    if not s:
        return None
    parts = [int(p) for p in s.split("-")]
    y, m, d = (parts + [1, 1])[:3]
    if not end:
        return int(datetime(y, m, d).timestamp() * 1000)
    if len(parts) == 1:
        nxt = datetime(y + 1, 1, 1)
    elif len(parts) == 2:
        nxt = datetime(y + (m == 12), m % 12 + 1, 1)
    else:
        nxt = datetime.fromtimestamp(datetime(y, m, d).timestamp() + 86400)
    return int(nxt.timestamp() * 1000) - 1


@dataclass
class Filters:
    q: str = ""
    kinds: list[str] = field(default_factory=list)
    author_ids: list[int] = field(default_factory=list)
    with_ids: list[int] = field(default_factory=list)
    thread_id: str | None = None
    since: int | None = None
    until: int | None = None


def _where(f: Filters, fts: str | None) -> tuple[str, list[Any]]:
    clauses: list[str] = []
    params: list[Any] = []
    if fts:
        clauses.append("items_fts MATCH ?")
        params.append(fts)
    if f.kinds:
        clauses.append(f"i.kind IN ({','.join('?' * len(f.kinds))})")
        params += f.kinds
    elif not f.thread_id:
        clauses.append(f"i.kind NOT IN ({','.join('?' * len(HIDDEN_BY_DEFAULT))})")
        params += HIDDEN_BY_DEFAULT
    if f.author_ids:
        clauses.append(f"i.author_id IN ({','.join('?' * len(f.author_ids))})")
        params += f.author_ids
    if f.with_ids:
        clauses.append(
            "i.thread_id IN (SELECT thread_id FROM thread_people "
            f"WHERE person_id IN ({','.join('?' * len(f.with_ids))}))"
        )
        params += f.with_ids
    if f.thread_id:
        clauses.append("i.thread_id = ?")
        params.append(f.thread_id)
    if f.since is not None:
        clauses.append("i.ts >= ?")
        params.append(f.since)
    if f.until is not None:
        clauses.append("i.ts <= ?")
        params.append(f.until)
    return (" WHERE " + " AND ".join(clauses)) if clauses else "", params


def _run_fts(conn: sqlite3.Connection, f: Filters, build) -> list[sqlite3.Row]:
    """Run a query built by `build(fts_expr)`, retrying with escaped words on syntax errors."""
    fts = to_fts_query(f.q)
    try:
        return conn.execute(*build(fts)).fetchall()
    except sqlite3.OperationalError:
        if not f.q:
            raise
        return conn.execute(*build(safe_fts_query(f.q))).fetchall()


ITEM_COLS = (
    "i.id, i.kind, i.category, i.ts, i.title, i.body, i.meta, i.extra, i.thread_id, "
    "i.author_id, "
    "t.title AS thread_title, p.name AS author, p.is_me AS author_is_me"
)
ITEM_JOINS = "LEFT JOIN threads t ON t.id = i.thread_id LEFT JOIN people p ON p.id = i.author_id"


def search(
    conn: sqlite3.Connection,
    f: Filters,
    limit: int = 50,
    offset: int = 0,
    sort: str = "rank",
) -> dict[str, Any]:
    """Return `{"total": int, "items": [...]}`; ranked by BM25 when there's a query."""

    def base(fts: str | None) -> str:
        return "FROM items_fts JOIN items i ON i.id = items_fts.rowid" if fts else "FROM items i"

    def build(fts: str | None):
        where, params = _where(f, fts)
        if fts:
            snip = f"snippet(items_fts, -1, '{HL_START}', '{HL_END}', '…', 24)"
        else:
            snip = "substr(coalesce(i.body, i.meta, ''), 1, 300)"
        order = {
            "new": "i.ts DESC",
            "old": "i.ts ASC",
        }.get(sort, "bm25(items_fts, 3.0, 10.0, 1.0), i.ts DESC" if fts else "i.ts DESC")
        sql = (
            f"SELECT {ITEM_COLS}, {snip} AS snippet "
            f"{base(fts)} {ITEM_JOINS}{where} ORDER BY {order} LIMIT ? OFFSET ?"
        )
        return sql, [*params, limit, offset]

    def build_count(fts: str | None):
        # Separate query: FTS5 aux functions (bm25, snippet) can't share one with a window.
        where, params = _where(f, fts)
        return f"SELECT count(*) AS total {base(fts)}{where}", params

    if f.q and not to_fts_query(f.q):
        return {"total": 0, "items": []}
    rows = _run_fts(conn, f, build)
    items = [_item(r) for r in rows]
    _attach_media(conn, items)
    total = _run_fts(conn, f, build_count)[0]["total"]
    return {"total": total, "items": items}


def histogram(conn: sqlite3.Connection, f: Filters) -> list[dict[str, Any]]:
    """Hit counts per month and kind, for the timeline bar chart."""

    def build(fts: str | None):
        where, params = _where(f, fts)
        base = "FROM items_fts JOIN items i ON i.id = items_fts.rowid" if fts else "FROM items i"
        # Future-dated events (old invitations to 2029...) would stretch the axis.
        where = (where + " AND" if where else " WHERE") + (
            " i.ts IS NOT NULL AND i.ts <= unixepoch('now') * 1000"
        )
        sql = (
            "SELECT strftime('%Y-%m', i.ts / 1000, 'unixepoch', 'localtime') AS month, "
            f"i.kind, count(*) AS n {base}{where} GROUP BY month, i.kind ORDER BY month"
        )
        return sql, params

    if f.q and not to_fts_query(f.q):
        return []
    return [dict(r) for r in _run_fts(conn, f, build)]


def _item(r: sqlite3.Row) -> dict[str, Any]:
    d = dict(r)
    d["extra"] = orjson.loads(d["extra"]) if d.get("extra") else None
    d.pop("total", None)
    return d


def _attach_media(conn: sqlite3.Connection, items: list[dict[str, Any]]) -> None:
    if not items:
        return
    by_id = {it["id"]: it for it in items}
    for it in items:
        it["media"] = []
    ids = list(by_id)
    for chunk in range(0, len(ids), 900):
        part = ids[chunk : chunk + 900]
        marks = ",".join("?" * len(part))
        for m in conn.execute(
            f"SELECT id, item_id, mtype, path FROM media WHERE item_id IN ({marks})", part
        ):
            by_id[m["item_id"]]["media"].append(
                {"id": m["id"], "mtype": m["mtype"], "name": m["path"].rsplit("/", 1)[-1]}
            )


def get_item(conn: sqlite3.Connection, item_id: int) -> dict[str, Any] | None:
    r = conn.execute(f"SELECT {ITEM_COLS} FROM items i {ITEM_JOINS} WHERE i.id = ?", (item_id,))
    row = r.fetchone()
    if not row:
        return None
    items = [_item(row)]
    _attach_media(conn, items)
    return items[0]


def thread_info(conn: sqlite3.Connection, thread_id: str) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM threads WHERE id = ?", (thread_id,)).fetchone()
    if not row:
        return None
    info = dict(row)
    info["people"] = [
        dict(p)
        for p in conn.execute(
            "SELECT p.id, p.name, p.is_me, "
            "(SELECT count(*) FROM items WHERE thread_id = ? AND author_id = p.id) AS n "
            "FROM thread_people tp JOIN people p ON p.id = tp.person_id "
            "WHERE tp.thread_id = ? ORDER BY n DESC",
            (thread_id, thread_id),
        )
    ]
    return info


def thread_window(
    conn: sqlite3.Connection,
    thread_id: str,
    around: int | None = None,
    before: tuple[int, int] | None = None,
    after: tuple[int, int] | None = None,
    n: int = 60,
) -> list[dict[str, Any]]:
    """Chronological slice of a thread, keyed by (ts, id) cursors.

    `around` centres on an item; `before`/`after` page older/newer from a cursor;
    with neither, returns the latest messages.
    """
    cols = f"SELECT {ITEM_COLS} FROM items i {ITEM_JOINS} WHERE i.thread_id = ?"

    def older(ts: int, iid: int, k: int, inclusive: bool = False) -> list[sqlite3.Row]:
        op = "<=" if inclusive else "<"
        return conn.execute(
            f"{cols} AND (i.ts, i.id) {op} (?, ?) ORDER BY i.ts DESC, i.id DESC LIMIT ?",
            (thread_id, ts, iid, k),
        ).fetchall()[::-1]

    def newer(ts: int, iid: int, k: int) -> list[sqlite3.Row]:
        return conn.execute(
            f"{cols} AND (i.ts, i.id) > (?, ?) ORDER BY i.ts ASC, i.id ASC LIMIT ?",
            (thread_id, ts, iid, k),
        ).fetchall()

    if around is not None:
        anchor = conn.execute("SELECT ts, id FROM items WHERE id = ?", (around,)).fetchone()
        if not anchor:
            return []
        rows = older(anchor[0], anchor[1], n // 2, inclusive=True) + newer(
            anchor[0], anchor[1], n // 2
        )
    elif before is not None:
        rows = older(*before, n)
    elif after is not None:
        rows = newer(*after, n)
    else:
        rows = conn.execute(
            f"{cols} ORDER BY i.ts DESC, i.id DESC LIMIT ?", (thread_id, n)
        ).fetchall()[::-1]
    items = [_item(r) for r in rows]
    _attach_media(conn, items)
    return items


def list_threads(
    conn: sqlite3.Connection,
    q: str = "",
    with_id: int | None = None,
    limit: int = 100,
    offset: int = 0,
) -> list[dict[str, Any]]:
    """Threads by recent activity, each with its last message for the inbox preview."""
    clauses, params = ["t.n_items > 0"], []
    if q:
        clauses.append("t.title LIKE ?")
        params.append(f"%{q}%")
    if with_id is not None:
        clauses.append("t.id IN (SELECT thread_id FROM thread_people WHERE person_id = ?)")
        params.append(with_id)
    sql = (
        "WITH page AS (SELECT t.* FROM threads t WHERE " + " AND ".join(clauses) + " "
        "  ORDER BY t.last_ts DESC LIMIT ? OFFSET ?), "
        "last AS (SELECT page.id AS tid, (SELECT i.id FROM items i WHERE i.thread_id = page.id "
        "  ORDER BY i.ts DESC, i.id DESC LIMIT 1) AS iid FROM page) "
        "SELECT page.*, i.body AS last_body, p.name AS last_author, p.is_me AS last_is_me, "
        "  (SELECT mtype FROM media WHERE item_id = i.id LIMIT 1) AS last_mtype "
        "FROM page JOIN last ON last.tid = page.id LEFT JOIN items i ON i.id = last.iid "
        "LEFT JOIN people p ON p.id = i.author_id ORDER BY page.last_ts DESC"
    )
    return [dict(r) for r in conn.execute(sql, [*params, limit, offset])]


def on_this_day(conn: sqlite3.Connection, month_day: str) -> dict[str, Any]:
    """Memories for a MM-DD: standalone items plus per-thread message counts, by year."""
    day = "strftime('%m-%d', i.ts / 1000, 'unixepoch', 'localtime') = ?"
    items = [
        _item(r)
        for r in conn.execute(
            f"SELECT {ITEM_COLS}, substr(coalesce(i.body, i.meta, ''), 1, 400) AS snippet "
            f"FROM items i {ITEM_JOINS} WHERE {day} AND i.thread_id IS NULL "
            "AND i.kind IN ('post', 'photo', 'video', 'comment', 'event', 'friend', 'group') "
            "ORDER BY i.ts DESC LIMIT 150",
            (month_day,),
        )
    ]
    _attach_media(conn, items)
    convos = [
        dict(r)
        for r in conn.execute(
            "SELECT i.thread_id, t.title AS thread_title, t.is_group, "
            "strftime('%Y', i.ts / 1000, 'unixepoch', 'localtime') AS year, count(*) AS n, "
            "min(i.id) AS first_id, max(i.ts) AS ts "
            f"FROM items i JOIN threads t ON t.id = i.thread_id WHERE {day} "
            "GROUP BY i.thread_id, year ORDER BY year DESC, n DESC",
            (month_day,),
        )
    ]
    return {"items": items, "conversations": convos}


def list_people(
    conn: sqlite3.Connection, q: str = "", limit: int = 50, offset: int = 0
) -> list[dict[str, Any]]:
    """People ranked by how much they wrote; `q` matches ignoring case."""
    where, params = ("WHERE p.name LIKE ?", [f"%{q}%"]) if q else ("", [])
    sql = (
        "SELECT p.id, p.name, p.is_me, "
        "(SELECT count(*) FROM items WHERE author_id = p.id) AS n_items, "
        "(SELECT count(*) FROM thread_people WHERE person_id = p.id) AS n_threads "
        f"FROM people p {where} ORDER BY n_items DESC, p.id LIMIT ? OFFSET ?"
    )
    return [dict(r) for r in conn.execute(sql, [*params, limit, offset])]


def resolve_people(conn: sqlite3.Connection, name: str) -> list[int]:
    return [r[0] for r in conn.execute("SELECT id FROM people WHERE name LIKE ?", (f"%{name}%",))]


def me_id(conn: sqlite3.Connection) -> int | None:
    row = conn.execute("SELECT id FROM people WHERE is_me = 1").fetchone()
    return row[0] if row else None


def person_profile(conn: sqlite3.Connection, person_id: int) -> dict[str, Any] | None:
    row = conn.execute("SELECT id, name, is_me FROM people WHERE id = ?", (person_id,)).fetchone()
    if not row:
        return None
    prof = dict(row)
    # Volume of conversation with them: every message in their 1:1 threads plus theirs in groups.
    prof["per_year"] = [
        dict(r)
        for r in conn.execute(
            "SELECT strftime('%Y', i.ts / 1000, 'unixepoch', 'localtime') AS year, "
            "sum(i.author_id = ?) AS theirs, sum(i.author_id != ?) AS others, count(*) AS n "
            "FROM items i JOIN threads t ON t.id = i.thread_id "
            "WHERE i.thread_id IN (SELECT thread_id FROM thread_people WHERE person_id = ?) "
            "AND (t.is_group = 0 OR i.author_id = ?) AND i.ts IS NOT NULL "
            "GROUP BY year ORDER BY year",
            (person_id, person_id, person_id, person_id),
        )
    ]
    prof["threads"] = list_threads(conn, with_id=person_id, limit=200)
    prof["n_threads"] = conn.execute(
        "SELECT count(*) FROM thread_people tp JOIN threads t ON t.id = tp.thread_id "
        "WHERE tp.person_id = ? AND t.n_items > 0",
        (person_id,),
    ).fetchone()[0]
    prof["n_items"] = conn.execute(
        "SELECT count(*) FROM items WHERE author_id = ?", (person_id,)
    ).fetchone()[0]
    first_last = conn.execute(
        "SELECT min(ts), max(ts) FROM items WHERE author_id = ?", (person_id,)
    ).fetchone()
    prof["first_ts"], prof["last_ts"] = first_last
    return prof


def gallery(
    conn: sqlite3.Connection,
    f: Filters,
    mtypes: tuple[str, ...] = ("photo", "gif", "video"),
    limit: int = 200,
    offset: int = 0,
    sort: str = "new",
) -> list[dict[str, Any]]:
    where, params = _where(Filters(**{**f.__dict__, "q": ""}), None)
    where = (where + " AND" if where else " WHERE") + (
        f" m.mtype IN ({','.join('?' * len(mtypes))})"
    )
    order = "i.ts ASC" if sort == "old" else "i.ts DESC"
    sql = (
        "SELECT m.id, m.mtype, m.item_id, i.ts, i.kind, i.thread_id, t.title AS thread_title, "
        "p.name AS author FROM media m JOIN items i ON i.id = m.item_id "
        f"{ITEM_JOINS}{where} ORDER BY {order}, m.id LIMIT ? OFFSET ?"
    )
    return [dict(r) for r in conn.execute(sql, [*params, *mtypes, limit, offset])]


def stats(conn: sqlite3.Connection) -> dict[str, Any]:
    return {
        "kinds": {
            r[0]: r[1]
            for r in conn.execute("SELECT kind, count(*) FROM items GROUP BY kind ORDER BY 2 DESC")
        },
        "threads": conn.execute("SELECT count(*) FROM threads WHERE n_items > 0").fetchone()[0],
        "people": conn.execute("SELECT count(*) FROM people").fetchone()[0],
        "media": conn.execute("SELECT count(*) FROM media").fetchone()[0],
        "range": list(conn.execute("SELECT min(ts), max(ts) FROM items").fetchone()),
        "me": (conn.execute("SELECT name FROM people WHERE is_me = 1").fetchone() or [None])[0],
        "me_id": me_id(conn),
        "me_avatar": _album_cover(conn, "Profilepictures"),
        "me_cover": _album_cover(conn, "Coverphotos"),
        "sources": [dict(r) for r in conn.execute("SELECT * FROM sources")],
    }


def _album_cover(conn: sqlite3.Connection, album_prefix: str) -> int | None:
    """Most recent photo of an album folder (Facebook names them e.g. Profilepictures_123)."""
    row = conn.execute(
        "SELECT m.id FROM media m JOIN items i ON i.id = m.item_id "
        "WHERE m.path LIKE ? AND m.mtype = 'photo' ORDER BY i.ts DESC LIMIT 1",
        (f"%/{album_prefix}_%",),
    ).fetchone()
    return row[0] if row else None


def media_path(conn: sqlite3.Connection, media_id: int) -> tuple[str, str] | None:
    """Absolute path and type of a media row."""
    row = conn.execute(
        "SELECT s.root, m.path, m.mtype FROM media m JOIN sources s ON s.id = m.source_id "
        "WHERE m.id = ?",
        (media_id,),
    ).fetchone()
    return (f"{row[0]}/{row[1]}", row[2]) if row else None
