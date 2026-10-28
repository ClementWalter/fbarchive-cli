# fbarchive-cli

**Visibility: public.**

**Extension: not shipped** as a Claude Desktop extension: it needs the user's own Facebook export imported from a terminal first.

Fast, local search and a clean Facebook-like viewer for a Facebook **"Download your information"**
export (JSON format). Everything stays on your machine.

- **Facebook-like UI**: a top bar with global search, a left sidebar, a
  central feed and a right-hand column, in light and dark mode, and usable on
  a phone.
- **Home: On this day**: memories from this date in past years (posts, photos,
  and the conversations you had that day).
- **Full-text search** over Messenger, posts, comments, reactions, events,
  groups, friends and activity logs. Results appear as you type and ignore
  accents (`reunion` finds `réunion`). FTS5 syntax (`"exact phrase"`,
  `a OR b`, `NEAR(a b)`) is passed straight through. You can filter by
  conversation partner, author, year or type, and a bar chart shows when the
  hits happened.
- **Messenger**: an inbox with the last message of each chat, and
  conversations with grouped bubbles, reactions, stickers, photos, videos,
  calls and shared links. It opens at the message a search found, scrolls
  back and forward through the whole thread, and has a members panel.
- **Profiles**: cover and avatar (your real ones for your own profile),
  messages exchanged per year, conversations, photos and activity.
- **People**: a grid of everyone, ranked by messages.
- **Memories**: the whole archive month by month, with a heatmap per year.
- **Events**: each event has its own page with the date, place (and a map
  link), your RSVP (going, interested, can't go, invited or your own event),
  the description, a link to the event on Facebook, and the conversations that
  mention it or that happened that day. You can filter events by RSVP.
- **Item pages**: click any post, comment or photo card to open it on its own
  page, next to that day's conversations.
- **Photos**: every photo and video by month, with a full-screen viewer
  (←/→ to browse) that links back to the conversation.
- Facebook's double-encoded UTF-8 (`Ã©` for `é`) is repaired on import.
- Re-importable: point it at any number of exports and items are deduplicated
  by content, so re-running is a no-op.

## Install

```bash
git clone git@github.com:ClementWalter/fbarchive-cli ~/Documents/fbarchive-cli
uv run ~/Documents/claudine/scripts/link_clis.py   # links bin/fbarchive into ~/.local/bin
```

`bin/fbarchive` is a PEP 723 shim: uv runs the checkout with the exact pins of
`pyproject.toml`, so a `git pull` applies at once.

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
