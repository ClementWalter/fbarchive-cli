"""FastAPI app serving the JSON API, media files, thumbnails and the single-page UI."""

import hashlib
import logging
import sqlite3
import threading
from datetime import datetime
from pathlib import Path
from typing import Annotated

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps

from fbarchive import search as s
from fbarchive.db import connect

log = logging.getLogger(__name__)
STATIC = Path(__file__).parent / "static"
THUMB_SIZES = (160, 320, 640)


def create_app(db_path: Path, thumbs_dir: Path) -> FastAPI:
    app = FastAPI(title="fbarchive", docs_url="/api/docs")
    local = threading.local()

    def db() -> sqlite3.Connection:
        # One read-only connection per worker thread; sqlite3 objects aren't thread-safe.
        if not hasattr(local, "conn"):
            local.conn = connect(db_path, readonly=True)
        return local.conn

    def filters(
        q: str,
        kind: str,
        author: str,
        with_: str,
        thread: str,
        since: str,
        until: str,
        category: str = "",
    ) -> s.Filters:
        return s.Filters(
            category=category or None,
            q=q,
            kinds=[k for k in kind.split(",") if k],
            author_ids=[int(x) for x in author.split(",") if x],
            with_ids=[int(x) for x in with_.split(",") if x],
            thread_id=thread or None,
            since=s.parse_date(since),
            until=s.parse_date(until, end=True),
        )

    Str = Annotated[str, Query()]

    @app.get("/api/stats")
    def api_stats():
        return s.stats(db())

    @app.get("/api/search")
    def api_search(
        q: Str = "",
        kind: Str = "",
        author: Str = "",
        with_: Annotated[str, Query(alias="with")] = "",
        thread: Str = "",
        since: Str = "",
        until: Str = "",
        category: Str = "",
        sort: Str = "rank",
        limit: int = 50,
        offset: int = 0,
    ):
        f = filters(q, kind, author, with_, thread, since, until, category)
        return s.search(db(), f, limit=min(limit, 500), offset=offset, sort=sort)

    @app.get("/api/histogram")
    def api_histogram(
        q: Str = "",
        kind: Str = "",
        author: Str = "",
        with_: Annotated[str, Query(alias="with")] = "",
        thread: Str = "",
        since: Str = "",
        until: Str = "",
    ):
        return s.histogram(db(), filters(q, kind, author, with_, thread, since, until))

    @app.get("/api/item/{item_id}")
    def api_item(item_id: int):
        if not (it := s.get_item(db(), item_id)):
            raise HTTPException(404)
        return it

    @app.get("/api/thread/{thread_id}")
    def api_thread(thread_id: str):
        if not (info := s.thread_info(db(), thread_id)):
            raise HTTPException(404)
        return info

    @app.get("/api/thread/{thread_id}/messages")
    def api_thread_messages(
        thread_id: str,
        around: int | None = None,
        before_ts: int | None = None,
        before_id: int | None = None,
        after_ts: int | None = None,
        after_id: int | None = None,
        n: int = 80,
    ):
        before = (before_ts, before_id) if before_ts is not None else None
        after = (after_ts, after_id) if after_ts is not None else None
        return s.thread_window(db(), thread_id, around=around, before=before, after=after, n=n)

    @app.get("/api/threads")
    def api_threads(
        q: Str = "",
        with_: Annotated[int | None, Query(alias="with")] = None,
        limit: int = 50,
        offset: int = 0,
    ):
        return s.list_threads(db(), q=q, with_id=with_, limit=min(limit, 500), offset=offset)

    @app.get("/api/onthisday")
    def api_onthisday(day: Str = ""):
        return s.on_this_day(db(), day or datetime.now().strftime("%m-%d"))

    @app.get("/api/people")
    def api_people(q: Str = "", limit: int = 50, offset: int = 0):
        return s.list_people(db(), q=q, limit=min(limit, 1000), offset=offset)

    @app.get("/api/person/{person_id}")
    def api_person(person_id: int):
        if not (p := s.person_profile(db(), person_id)):
            raise HTTPException(404)
        return p

    @app.get("/api/gallery")
    def api_gallery(
        kind: Str = "",
        author: Str = "",
        with_: Annotated[str, Query(alias="with")] = "",
        thread: Str = "",
        since: Str = "",
        until: Str = "",
        sort: Str = "new",
        limit: int = 200,
        offset: int = 0,
    ):
        f = filters("", kind, author, with_, thread, since, until)
        return s.gallery(db(), f, limit=min(limit, 1000), offset=offset, sort=sort)

    @app.get("/media/{media_id}")
    def media(media_id: int):
        path = _media_file(db(), media_id)
        return FileResponse(path)

    @app.get("/thumb/{media_id}")
    def thumb(media_id: int, s_: Annotated[int, Query(alias="s")] = 320):
        size = min(THUMB_SIZES, key=lambda x: abs(x - s_))
        src = _media_file(db(), media_id)
        key = hashlib.blake2b(src.encode(), digest_size=10).hexdigest()
        out = thumbs_dir / str(size) / key[:2] / f"{key}.webp"
        if not out.exists():
            try:
                _make_thumb(Path(src), out, size)
            except OSError as e:
                log.warning("thumbnail failed for %s: %s", src, e)
                return FileResponse(src)
        # Thumbnails are immutable for a given source path.
        return FileResponse(out, headers={"Cache-Control": "public, max-age=31536000"})

    app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")
    return app


def _media_file(conn: sqlite3.Connection, media_id: int) -> str:
    found = s.media_path(conn, media_id)
    if not found or not Path(found[0]).exists():
        raise HTTPException(404)
    return found[0]


def _make_thumb(src: Path, out: Path, size: int) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(src) as im:
        im = ImageOps.exif_transpose(im)
        im.thumbnail((size, size))
        if im.mode not in ("RGB", "RGBA"):
            im = im.convert("RGBA" if "transparency" in im.info else "RGB")
        tmp = out.with_suffix(".tmp")
        im.save(tmp, "WEBP", quality=78)
        tmp.replace(out)
