"""Command-line interface: import exports, search, read threads and serve the web UI."""

import logging
import os
import webbrowser
from datetime import datetime
from pathlib import Path

import click
import orjson

from fbarchive import search as s
from fbarchive.db import connect, default_db_path
from fbarchive.importers import facebook
from fbarchive.indexer import Indexer

log = logging.getLogger("fbarchive")


def _fmt_ts(ms: int | None) -> str:
    return datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d %H:%M") if ms else "????-??-??"


def _highlight(text: str) -> str:
    return (
        text.replace(s.HL_START, click.style("", fg="yellow", bold=True, reset=False))
        .replace(s.HL_END, click.style("", reset=True))
        .replace("\n", " ")
    )


@click.group()
@click.option(
    "--db",
    "db_path",
    type=click.Path(path_type=Path),
    default=default_db_path,
    show_default="$FBARCHIVE_DB or ~/.local/share/fbarchive/archive.db",
    help="SQLite index location.",
)
@click.option("-v", "--verbose", is_flag=True)
@click.pass_context
def main(ctx: click.Context, db_path: Path, verbose: bool) -> None:
    """Fast local search over your Facebook data export.

    \b
    Examples:
      fbarchive import ~/Drive/meta-2026-Sep-09     # folder with facebook-* exports
      fbarchive search "appart lyon" --with Marie --since 2019
      fbarchive thread fb:mariedupont_123 --around 48213
      fbarchive serve --open
    """
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO, format="%(levelname)s %(message)s"
    )
    ctx.obj = db_path


@main.command("import")
@click.argument("paths", nargs=-1, required=True, type=click.Path(exists=True, path_type=Path))
@click.pass_obj
def import_(db_path: Path, paths: tuple[Path, ...]) -> None:
    """Index one or more exports. Safe to re-run: already-known items are skipped.

    Each PATH is an export root or a folder holding several `facebook-*` exports.
    """
    conn = connect(db_path)
    ix = Indexer(conn)
    for path in paths:
        for root in facebook.find_exports(path.resolve()):
            st = ix.ingest(facebook.PLATFORM, root, facebook.iter_export(root))
            log.info(
                "%s: %d items (%d new), %d threads, %d new media in %.1fs",
                root.name,
                st.items_seen,
                st.items_new,
                st.threads,
                st.media_new,
                st.seconds,
            )
    ix.finalize()
    log.info("index ready at %s", db_path)


def _filters(conn, q, kind, author, with_, thread, since, until) -> s.Filters:
    def ids(name: str | None) -> list[int]:
        if not name:
            return []
        found = s.resolve_people(conn, name)
        if not found:
            raise click.BadParameter(f"no person matching {name!r}")
        return found

    return s.Filters(
        q=q,
        kinds=list(kind),
        author_ids=ids(author),
        with_ids=ids(with_),
        thread_id=thread,
        since=s.parse_date(since),
        until=s.parse_date(until, end=True),
    )


@main.command("search")
@click.argument("query", default="")
@click.option("-k", "--kind", multiple=True, help="message, post, comment, photo, event, log...")
@click.option("--from", "author", help="Written by this person (name substring).")
@click.option("--with", "with_", help="In conversations with this person (name substring).")
@click.option("--thread", help="Restrict to one thread id.")
@click.option("--since", help="YYYY, YYYY-MM or YYYY-MM-DD.")
@click.option("--until", help="YYYY, YYYY-MM or YYYY-MM-DD (inclusive).")
@click.option("--sort", type=click.Choice(["rank", "new", "old"]), default="rank")
@click.option("-n", "--limit", default=20, show_default=True)
@click.option("--json", "as_json", is_flag=True, help="Machine-readable output.")
@click.pass_obj
def search_cmd(db_path, query, kind, author, with_, thread, since, until, sort, limit, as_json):
    """Full-text search (accent-insensitive, last word is a prefix).

    FTS5 syntax is passed through when used: "exact phrase", a OR b, NEAR(a b), foo*.
    """
    conn = connect(db_path, readonly=True)
    f = _filters(conn, query, kind, author, with_, thread, since, until)
    res = s.search(conn, f, limit=limit, sort=sort)
    if as_json:
        click.echo(orjson.dumps(res).decode())
        return
    for it in res["items"]:
        where = it["thread_title"] or it["title"] or it["category"]
        who = f"{it['author']}: " if it["author"] else ""
        click.echo(
            f"{click.style(_fmt_ts(it['ts']), fg='cyan')} "
            f"{click.style(it['kind'], fg='magenta')} #{it['id']} "
            f"{click.style(str(where), bold=True)}"
        )
        click.echo(f"    {who}{_highlight(it['snippet'] or '')}")
    click.echo(click.style(f"{res['total']} results", dim=True), err=True)


@main.command("thread")
@click.argument("thread_id")
@click.option("--around", type=int, help="Centre on this item id (from search output).")
@click.option("-n", default=40, show_default=True)
@click.option("--json", "as_json", is_flag=True)
@click.pass_obj
def thread_cmd(db_path, thread_id, around, n, as_json):
    """Print a conversation, the latest messages or around one item."""
    conn = connect(db_path, readonly=True)
    msgs = s.thread_window(conn, thread_id, around=around, n=n)
    if as_json:
        click.echo(orjson.dumps(msgs).decode())
        return
    for m in msgs:
        mark = click.style(">>", fg="yellow") if m["id"] == around else "  "
        body = m["body"] or m["meta"] or " ".join(f"[{x['mtype']}]" for x in m["media"])
        click.echo(
            f"{mark}{click.style(_fmt_ts(m['ts']), fg='cyan')} "
            f"{click.style(m['author'] or '?', bold=True)}: {body}"
        )


@main.command("people")
@click.argument("query", default="")
@click.option("-n", "--limit", default=30, show_default=True)
@click.pass_obj
def people_cmd(db_path, query, limit):
    """List people by activity (optionally filtered by name)."""
    conn = connect(db_path, readonly=True)
    for p in s.list_people(conn, q=query, limit=limit):
        click.echo(f"{p['id']:>6} {p['n_items']:>7} msgs {p['n_threads']:>4} threads  {p['name']}")


@main.command("stats")
@click.pass_obj
def stats_cmd(db_path):
    """Summary of what's indexed."""
    click.echo(orjson.dumps(s.stats(connect(db_path, readonly=True)), option=orjson.OPT_INDENT_2))


@main.command("serve")
@click.option("--host", default="127.0.0.1", show_default=True)
@click.option("--port", default=8765, show_default=True)
@click.option("--open", "open_browser", is_flag=True, help="Open the UI in the browser.")
@click.pass_obj
def serve_cmd(db_path, host, port, open_browser):
    """Serve the web UI (search, threads, people, timeline, gallery)."""
    import uvicorn

    from fbarchive.server import create_app

    if not db_path.exists():
        raise click.ClickException(f"no index at {db_path}; run `fbarchive import` first")
    thumbs = Path(os.environ.get("FBARCHIVE_THUMBS", db_path.parent / "thumbs"))
    app = create_app(db_path, thumbs)
    if open_browser:
        webbrowser.open(f"http://{host}:{port}/")
    uvicorn.run(app, host=host, port=port, log_level="warning")
