---
name: fbarchive-cli
description:
  "Search and read the user's own Facebook history (Messenger since 2007, posts,
  comments, reactions, events, groups, friends, photos) from the terminal via the
  `fbarchive` command. It queries a local SQLite FTS5 index built from Facebook's
  'Download your information' export, fully offline and in milliseconds.
  `fbarchive search <text>` (accent-insensitive, filters --with/--from/--since/
  --until/--kind), `fbarchive threads` lists conversations, `fbarchive thread
  <id> --around <item>` reads a conversation around a hit, `fbarchive people`
  finds people, `fbarchive import <folder>` indexes a new export, and
  `fbarchive serve --open` opens the Facebook-like web viewer. Every read supports
  --json. Use when the user asks what they or someone said on Facebook or
  Messenger, wants to find an old post or message, or asks when something
  happened with a Facebook contact."
---

# fbarchive CLI

Offline, read-only access to the user's **own** Facebook data. The source is
the JSON export from Facebook's "Download your information", indexed into SQLite
with FTS5. Nothing calls Facebook: all queries run against the local index.

This skill lives at the root of the CLI repo (`~/Documents/fbarchive-cli`,
private GitHub repo `ClementWalter/fbarchive-cli`).

## How to invoke

Run it as **`fbarchive`** on `$PATH`. `uv run claudine/scripts/link_clis.py`
links `~/Documents/fbarchive-cli/bin/fbarchive` into `~/.local/bin`, so edits to
the checkout apply at once. Fallback: `<skill-dir>/bin/fbarchive`, a PEP 723
shim that uv runs with the package's exact pins.

The index lives at `~/.local/share/fbarchive/archive.db` (override with `--db`
or `FBARCHIVE_DB`). If it doesn't exist, build it first with `import`.

Use it when the user wants to **find or read something from their Facebook /
Messenger history**: what they said with someone about a topic, an old post,
when they last talked to someone, who was at an event. Don't use it for live
Facebook data: the index only contains what the export contains, and its last
message date is the export date (`fbarchive stats`).

## Authentication

None. Everything is read from the local index; nothing calls Facebook.

## Output conventions

- Default: compact text, one line per record, with the `#<item id>` and the
  `[<thread id>]` the next command takes.
- `--json` on `search`, `thread`, `threads` and `people`: the query layer's
  records as JSON. `stats` always prints JSON.
- stdout carries data only; the result count and logs go to stderr (`-v` for
  DEBUG).

## Commands

```bash
# Read
fbarchive search "appart lyon" --with Marie --since 2018 --until 2019
fbarchive search -k post --since 2015 --until 2015 --sort old
fbarchive search anniversaire --from Paul --json
fbarchive threads --limit 5                    # conversations by recent activity
fbarchive threads --with Marie --json
fbarchive thread fb:mariedupont_1234 --around 48213 -n 20
fbarchive people marie
fbarchive stats                                # counts, date range, sources
fbarchive serve --open                         # web UI at http://127.0.0.1:8765

# Write (local index only)
fbarchive import ~/Drive/meta-2026-Sep-09      # export root or folder of facebook-* exports
```

### Details

#### `fbarchive search [QUERY] [filters] [--sort rank|new|old] [-n N] [--json]`

Full-text search across everything. It ignores accents (`reunion` matches
`réunion`), treats the last word as a prefix, and requires every word to match.
FTS5 syntax passes through unchanged: `"exact phrase"`, `ski OR snowboard`,
`NEAR(appart lyon)`, `velo*`. QUERY can be empty to browse by filters only.

- `--with NAME`: only conversations that include this person (name substring).
- `--from NAME`: only items written by this person.
- `--since` / `--until`: `YYYY`, `YYYY-MM` or `YYYY-MM-DD` (inclusive).
- `-k/--kind`: `message`, `post`, `comment`, `reaction`, `photo`, `video`,
  `event`, `friend`, `group`, `saved`, `search`, `activity`, `log`. Can be
  repeated. `log` (Meta's telemetry) is hidden unless you ask for it.
- `--thread ID`: search inside one conversation.

```bash
fbarchive search "appart lyon" --with Marie --since 2018 --until 2019
fbarchive search -k post --since 2015 --until 2015 --sort old
fbarchive search "anniversaire" --from Paul --json
```

Events are one record each (`-k event`), and their `--json` `extra.event`
holds `start`, `end`, `rsvp` (`going`, `interested`, `declined`, `invited`,
`hosted`, `visited` = page opened without answering), `place`, `address`,
`lat`/`lon`, `url` and `fbid` when Facebook exported them. The export never says
who hosted an event or invited you. To find out who sent it, search Messenger
for its id: `fbarchive search '"<fbid>"' -k message`.

#### `fbarchive threads [TITLE] [--with NAME] [-n N] [--json]`

Conversations ordered by most recent activity, with their thread ids.

#### `fbarchive thread ID [--around ITEM] [-n N] [--json]`

Prints a conversation: the latest `N` messages, or `N` messages centred on
`ITEM` (marked `>>`).

#### `fbarchive people [NAME] [-n N] [--json]`

People ranked by number of messages written, with their thread counts.

#### `fbarchive stats`

Counts per kind, date range, the owner's name, and the sources that were
imported.

#### `fbarchive import PATH...`

Indexes one export root, or a folder containing several `facebook-*` exports.
Re-running is safe because content already indexed is skipped. It takes about
5s for about 200k items.

#### `fbarchive serve [--port 8765] [--open]`

Serves the web UI at http://127.0.0.1:8765: a Facebook-like home (On this day),
live search, Messenger-style conversations, profiles, a people grid, memories
and a photo viewer. It blocks until Ctrl+C, so start it in the background when
you're driving it from an agent.

## Recipes

Search, then read the context of a hit:

```bash
fbarchive search "tire-bouchon"
# 2018-06-17 21:28 message #48213 Marie Dupont [fb:mariedupont_1234]
#     Paul Martin: pense à acheter un tire-bouchon
fbarchive thread fb:mariedupont_1234 --around 48213 -n 20
```

- When did I last talk to someone: `fbarchive threads --with <name> --limit 1`.
- Who sent an event: `fbarchive search '"<fbid>"' -k message` (the export never
  names the host).

## Gotchas

- **Names are display names.** Facebook exports have no stable person ids, and
  deleted accounts all appear as "Facebook user". `--with` / `--from` match
  every person whose name contains the substring.
- **Media** paths point into the raw export (on Google Drive). The web UI
  serves them; `--json` includes media ids but not file paths.
- `serve` blocks until Ctrl+C; start it in the background from an agent.
- `import` of about 215k items takes about 5s; queries take 10-20ms.
- **Privacy:** this is the user's private message history. Quote only what the
  user asked for, and never send it anywhere.
