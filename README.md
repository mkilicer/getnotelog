# notelog

**Memory for your AI.** notelog is a local MCP server that lets Claude Code, Codex, Cursor and Claude
Desktop save what matters and find it again in the next session. Every note is a plain Markdown file in
`~/notelog`: readable, editable, greppable, yours.

- **Your AI does the thinking.** It decides what to save, writes the title and the summary, and answers from
  your notes. notelog stores and searches. No API keys, no cloud, no LLM calls.
- **Plain files.** One `.md` file per note with a small frontmatter. Edit them in any editor, sync them with
  git or Dropbox, delete them; notelog re-reads the folder.
- **Fast search.** SQLite full-text index, rebuilt from the files at any time. Works well in English and
  Turkish, including natural questions ("where did I park the car?").
- **Decisions stick.** `log_decision` records what was decided and why; `load_context` brings it back at the
  start of the next session.

## Install

Requires Node.js 22.13 or newer.

```sh
npx -y notelog init --claude     # notes folder + Claude skill + registers the MCP server in Claude Code
```

Other clients:

```sh
codex mcp add notelog -- npx -y notelog mcp
```

Cursor, Claude Desktop and any MCP client (config file):

```json
{ "mcpServers": { "notelog": { "command": "npx", "args": ["-y", "notelog", "mcp"] } } }
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
notelog doctor                      Check the installation
```

`NOTELOG_DIR` changes the notes folder (default `~/notelog`).

## notelog Cloud

Want the same memory in Claude and ChatGPT on the web and on your phone? [getnotelog.com](https://getnotelog.com)
is a hosted notelog with a web view, sharing and team spaces. Syncing this folder with Cloud is on the roadmap.

## Development

```sh
npm install
npm test          # node:test, runs the TypeScript sources directly (Node 23.6+)
npm run build     # compiles to dist/
```

## License

MIT
