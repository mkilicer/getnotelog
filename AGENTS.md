# AGENTS.md — notelog (open-source core)

Local MCP server + CLI. Notes are Markdown files (`~/notelog`, `NOTELOG_DIR`); `<dir>/.notelog/index.db` is a
SQLite FTS5 index that can always be rebuilt from the files. The hosted product lives in a separate private
repo (`notelog-cloud`).

- `src/notes.ts` — note format: frontmatter (YAML) + body, ULID ids, file names, atomic writes
- `src/store.ts` — index sync (stat-based, no watcher), search (strict all-words, then stems), save/update
- `src/mcp.ts` — MCP tools (descriptions are written for the model: when to call)
- `src/sync.ts` — two-way sync with Cloud (`/api/v1/sync`): cursor + per-note version/hash in
  `.notelog/sync.json`, conflict copies, tombstones; credentials in `~/.config/notelog/credentials.json`
- `src/cli.ts` — `init / mcp / search / recent / add / reindex / login / sync / logout / doctor`
- `skill/notelog/SKILL.md` — when to load, search, save; how to write a note

Rules:
- Zero native dependencies: SQLite is `node:sqlite` (Node >= 22.13). Keep runtime deps minimal.
- The files are the source of truth. Never keep data only in the index; never rewrite a user's file except
  through `update`.
- No LLM calls. The only network call is sync, and only after `notelog login`.
- `npm test` (runs `src` directly) and `npm run build` before committing. Commit only when asked.
