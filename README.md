# fbarchive

Fast, local search and viewer for a Facebook **"Download your information"**
export (JSON format). Everything stays on your machine.

- **Full-text search** over Messenger, posts, comments, reactions, events,
  groups, friends and activity logs. It ignores accents (`reunion` finds
  `réunion`), treats the last word as a prefix, and passes FTS5 syntax
  (`"exact phrase"`, `a OR b`, `NEAR(a b)`) straight through.
- **Filters**: kind, "conversations with", "written by", date range, sort by
  relevance or date.
- **Thread view**: opens a conversation at the matching message, with infinite
  scroll in both directions, inline photos, videos, stickers and reactions.
- **People pages**: messages exchanged per year, and every thread with that
  person.
- **Timeline**: everything, month by month. Click a month to browse it.
- **Gallery**: every photo and video by month, filterable by person, thread and
  date, with cached WebP thumbnails.
- Facebook's double-encoded UTF-8 (`Ã©` for `é`) is repaired on import.
- Re-importable: point it at any number of exports and items are deduplicated
  by content, so re-running is a no-op.

## Install

```bash
uv tool install git+https://github.com/ClementWalter/fbarchive
# or, from a checkout
uv sync
```

## Use

```bash
# A folder holding one or more facebook-* export folders (or one export root)
fbarchive import ~/Drive/meta-2026-Sep-09-19-29-13

fbarchive search "appart lyon" --with Marie --since 2019 --until 2020
fbarchive search "anniv" -k post --sort old
fbarchive thread fb:mariedupont_1234 --around 48213
fbarchive people marie
fbarchive serve --open          # http://127.0.0.1:8765
```

Every read command supports `--json`.

The index lives at `~/.local/share/fbarchive/archive.db` (override with
`--db` or `FBARCHIVE_DB`). Thumbnails are cached next to it. The raw export is
never modified, and media are served from it on demand.

About 215k items (183k Messenger messages over 19 years) import in about 5s,
and queries return in 10–20ms.

## Design

- `importers/facebook.py` turns the export into generic `Thread` and `Item`
  records. Messenger has a dedicated parser. Every other JSON file goes through
  a walker that treats each timestamped dict as one record.
- `indexer.py` writes records to SQLite, with a content hash as the dedup key,
  then builds an FTS5 index (`unicode61 remove_diacritics 2`).
- `search.py` is the query layer, shared by the CLI (`cli.py`) and the FastAPI
  server (`server.py`, vanilla-JS UI in `static/`).

The schema is platform-agnostic (`platform` column, `thread` / `person` /
`item` / `media`), so other importers (WhatsApp, iMessage, Instagram) can be
added later.

## Roadmap

- Semantic text search (local multilingual embeddings, sqlite-vec)
- Semantic photo search (local CLIP/SigLIP) and OCR (Apple Vision)

## Develop

```bash
uv run pytest
prek run --all-files
```
