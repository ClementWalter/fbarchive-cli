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

This skill lives at the root of the CLI repo (`~/Documents/fbarchive`, private
GitHub repo `ClementWalter/fbarchive`).

## How to invoke

Run it as **`fbarchive`**. It is installed with `uv tool install --editable
~/Documents/fbarchive`, so edits to the checkout apply without reinstalling. If
it's missing:

```bash
uv tool install --editable ~/Documents/fbarchive
# or, without the checkout
uv tool install git+https://github.com/ClementWalter/fbarchive
```

The index lives at `~/.local/share/fbarchive/archive.db` (override with `--db`
or `FBARCHIVE_DB`). If it doesn't exist, build it first with `import`.

## When to use

Use it when the user wants to **find or read something from their Facebook /
Messenger history**:

- "what did Marie and I say about the apartment in 2018"
- "find that post where I shared …"
- "when did I last talk to X on Messenger"
- "who did I go skiing with in 2020"

Don't use it for live Facebook data. The index only contains what the export
contains, and its last message date is the export date (`fbarchive stats`).

## Workflow: search, then read the context

1. `fbarchive search "<words>"` (add filters) to find hits. Each hit shows `#<item
   id>` and, for messages, `[<thread id>]`.
2. `fbarchive thread <thread id> --around <item id>` to read the surrounding
   conversation.

```bash
fbarchive search "tire-bouchon"
# 2018-06-17 21:28 message #48213 Marie Dupont [fb:mariedupont_1234]
#     Paul Martin: pense à acheter un tire-bouchon
fbarchive thread fb:mariedupont_1234 --around 48213 -n 20
```

## Commands

### `fbarchive search [QUERY] [filters] [--sort rank|new|old] [-n N] [--json]`

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
fbarchive search "anniversaire" --from "Zoé Exemple" --json
```

Events are one record each (`-k event`), and their `--json` `extra.event`
holds `start`, `end`, `rsvp` (`going`, `interested`, `declined`, `invited`,
`hosted`), `place`, `address`, `lat`/`lon` and `url` when Facebook exported
them.

### `fbarchive threads [TITLE] [--with NAME] [-n N] [--json]`

Conversations ordered by most recent activity, with their thread ids.

### `fbarchive thread ID [--around ITEM] [-n N] [--json]`

Prints a conversation: the latest `N` messages, or `N` messages centred on
`ITEM` (marked `>>`).

### `fbarchive people [NAME] [-n N] [--json]`

People ranked by number of messages written, with their thread counts.

### `fbarchive stats`

Counts per kind, date range, the owner's name, and the sources that were
imported.

### `fbarchive import PATH...`

Indexes one export root, or a folder containing several `facebook-*` exports.
Re-running is safe because content already indexed is skipped. It takes about
5s for about 200k items.

### `fbarchive serve [--port 8765] [--open]`

Serves the web UI at http://127.0.0.1:8765: a Facebook-like home (On this day),
live search, Messenger-style conversations, profiles, a people grid, memories
and a photo viewer. It blocks until Ctrl+C, so start it in the background when
you're driving it from an agent.

## Notes

- **Names are display names.** Facebook exports have no stable person ids, and
  deleted accounts all appear as "Facebook user". `--with` / `--from` match
  every person whose name contains the substring.
- **Media** paths point into the raw export (on Google Drive). The web UI
  serves them; `--json` includes media ids but not file paths.
- **Privacy:** this is the user's private message history. Quote only what the
  user asked for, and never send it anywhere.
