# notelog

**Memory for your AI.** notelog is a local MCP server that lets Claude Code, Codex, Cursor and Claude
Desktop save what matters and find it again in the next session. Every note is a plain Markdown file in
`~/notelog`: readable, editable, greppable, yours.

- **Your AI does the thinking.** It decides what to save, writes the title and the summary, and answers from
  your notes. notelog stores and searches. No API keys, no LLM calls, no cloud unless you connect one.
- **Plain files.** One `.md` file per note with a small frontmatter. Edit them in any editor, sync them with
  git or Dropbox, delete them; notelog re-reads the folder.
- **Fast search.** SQLite full-text index, rebuilt from the files at any time. Works well in English and
  Turkish, including natural questions ("where did I park the car?").
- **Decisions stick.** `log_decision` records what was decided and why; `load_context` brings it back at the
  start of the next session.

## Install

Requires Node.js 22.13 or newer. The npm package is `getnotelog`; once installed, the command is also
available as `notelog`.

```sh
npx -y getnotelog init --claude  # notes folder + Claude skill + registers the MCP server in Claude Code
```

Other clients:

```sh
codex mcp add notelog -- npx -y getnotelog mcp
```

Cursor, Claude Desktop and any MCP client (config file):

```json
{ "mcpServers": { "notelog": { "command": "npx", "args": ["-y", "getnotelog", "mcp"] } } }
```

For Codex and Cursor, add the instructions in [`skill/notelog/SKILL.md`](./skill/notelog/SKILL.md) to your
`AGENTS.md` or rules, so the agent knows when to search and when to save. In Claude Code the skill is
installed by `notelog init`.

Then just work. Say "remember this", or let the agent save decisions on its own; ask "what did we decide
about payments?" in a new session.

## Tools

| Tool | What it does |
|---|---|
| `load_context` | At session start: recent decisions, notes on the topic, latest notes (per project) |
| `search_notes` | Full-text search; all words first, then word stems |
| `get_note` | Full text of a note |
| `save_note` | New note (title, tags, project) |
| `update_note` | Append to or replace a note, change title/tags |
| `log_decision` | A decision with its reason and alternatives |
| `recent_notes` | Latest notes, by project or tag |

## A note on disk

```markdown
---
id: 01M48K9DAQK8Q2XQJ7HC44CNEZ
title: "Decision: Use Polar for payments"
tags: [decision, billing]
project: shop
source: claude-code
created: 2026-10-06T12:33:49.398Z
updated: 2026-10-06T12:33:49.398Z
---

Use Polar for payments.

**Why:** merchant of record, handles EU VAT.
```

Files without frontmatter are notes too. `.notelog/index.db` is only a search index; delete it any time.

## Command line

```
notelog init [--claude] [--codex]   Create the notes folder, install the Claude skill, show setup
notelog mcp                         Run the MCP server on stdio
notelog search <words>              Search notes
notelog recent [n]                  Latest notes
notelog add <text>                  Save a note (or pipe text in)
notelog reindex                     Rebuild the index from the files
notelog login / sync / logout       Connect to notelog Cloud and sync
notelog doctor                      Check the installation
```

`NOTELOG_DIR` changes the notes folder (default `~/notelog`).

## notelog Cloud (optional)

[getnotelog.com](https://getnotelog.com) is a hosted notelog: Claude and ChatGPT connectors on the web and on
your phone, a web view, notebooks, sharing and team spaces. Connect this folder to it and the same notes are
everywhere, including the web (free up to 100 notes; Cloud plan for unlimited):

```sh
notelog login     # paste a personal API token from getnotelog.com/tokens
notelog sync      # also runs by itself every minute while the MCP server is running
```

Sync is two-way. If the same note was changed in two places, the first one to sync keeps the note and the other
text is saved next to it as a `(conflict ...)` note; nothing is overwritten silently. Deleting a note deletes it
everywhere. Team-space notes stay in Cloud. `notelog logout` disconnects; your files stay.

## Development

```sh
npm install
npm test          # node:test, runs the TypeScript sources directly (Node 23.6+)
npm run build     # compiles to dist/
```

## License

MIT

---

## Türkçe

**notelog, yapay zekân için hafıza.** Claude Code, Codex, Cursor ve Claude Desktop'un önemli şeyleri
kaydetmesini ve bir sonraki oturumda yeniden bulmasını sağlayan lokal bir MCP sunucusu. Her not `~/notelog`
klasöründe düz bir Markdown dosyası: okunur, düzenlenir, aranır; senindir.

- **Düşünmeyi senin yapay zekân yapar.** Neyin kaydedileceğine o karar verir, başlığı ve özeti o yazar,
  notlarından o cevaplar. notelog saklar ve bulur. API anahtarı yok, yapay zekâ çağrısı yok.
- **Düz dosyalar.** Her not bir `.md` dosyası. İstediğin editörde aç, git ya da Dropbox ile eşitle, sil;
  notelog klasörü yeniden okur.
- **Hızlı arama.** SQLite tam metin indeksi; Türkçe ve İngilizce, "arabayı nereye park etmiştim?" gibi soru
  cümleleriyle de çalışır.
- **Kararlar unutulmaz.** `log_decision` neyin neden kararlaştırıldığını kaydeder, `load_context` bir sonraki
  oturumun başında geri getirir.

**Kurulum** (Node.js 22.13+):

```sh
npx -y getnotelog init --claude
```

Codex için `codex mcp add notelog -- npx -y getnotelog mcp`; Cursor ve Claude Desktop için yukarıdaki MCP
ayarı. Defter (klasör) yerine etiket kullanılır: "annem defterine ekle" dersen not `annem` etiketiyle kaydedilir.

**notelog Cloud** ([getnotelog.com](https://getnotelog.com)): aynı notları web'de, telefonda ve Claude /
ChatGPT bağlantısında görmek için `notelog login` ve `notelog sync`. 100 nota kadar ücretsiz.
