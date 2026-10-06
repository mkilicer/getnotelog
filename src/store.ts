// The store: Markdown files in a directory plus a SQLite FTS5 index in <dir>/.notelog/index.db.
// Every read first reconciles the index with the files (cheap: one stat per file), so notes edited,
// added or deleted by hand, by git or by a sync tool are picked up without a watcher.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type Note,
  deriveTitle,
  newNotePath,
  normalizeTags,
  parseNote,
  serializeNote,
  ulid,
  writeFileAtomic,
} from "./notes.ts";

export type Hit = Omit<Note, "body"> & { snippet: string };
export type Filter = { project?: string | null; tag?: string | null };

const SCHEMA_VERSION = 1;

export function defaultDir(): string {
  const env = process.env.NOTELOG_DIR?.trim();
  if (env) return path.resolve(env.replace(/^~(?=$|\/)/, os.homedir()));
  return path.join(os.homedir(), "notelog");
}

/**
 * Case and Turkish-dotless-i folding that keeps string length, so offsets found in the folded text
 * are valid in the original (used for snippets). FTS5's unicode61 tokenizer removes the remaining
 * diacritics (ş, ğ, ü, ö, ç, é ...).
 */
export function fold(s: string): string {
  let out = "";
  for (const ch of s) {
    if (ch === "ı" || ch === "İ" || ch === "I") out += "i".repeat(ch.length);
    else {
      const l = ch.toLowerCase();
      out += l.length === ch.length ? l : ch;
    }
  }
  return out;
}

// Question and filler words that make "all words must match" fail for natural questions.
const STOP = new Set(
  (
    "ne nedir neydi nerede nereye nereden nasil nasıl hangi kim kime ne zaman mi mı mu mü miydi mıydı " +
    "bir bu şu o ve ile için icin de da ki ben sen biz benim bana bunu şunu var yok olan gibi daha en " +
    "the a an and or of to in on at for is are was were be been what where when which who how why " +
    "did do does my me i we our you your it this that with about from"
  ).split(" "),
);

export function queryTokens(query: string): string[] {
  const words = fold(query).match(/[\p{L}\p{N}]+/gu) ?? [];
  const kept = words.filter((w) => !STOP.has(w));
  return [...new Set(kept.length ? kept : words)];
}

/** Word stem for the lenient pass: Turkish and English suffixes mostly live past the 5th letter. */
const stem = (t: string) => (t.length > 5 ? t.slice(0, 5) : t);

export class Store {
  readonly dir: string;
  private db: DatabaseSync;
  private lastSync = 0;

  constructor(dir = defaultDir()) {
    this.dir = path.resolve(dir);
    fs.mkdirSync(path.join(this.dir, ".notelog"), { recursive: true });
    this.db = new DatabaseSync(path.join(this.dir, ".notelog", "index.db"));
    this.db.exec("pragma journal_mode = wal; pragma synchronous = normal;");
    this.migrate();
  }

  close() {
    this.db.close();
  }

  private migrate() {
    const v = (this.db.prepare("pragma user_version").get() as { user_version: number }).user_version;
    if (v === SCHEMA_VERSION) return;
    this.db.exec(`
      drop table if exists notes;
      drop table if exists notes_fts;
      create table notes (
        path text primary key, id text not null, title text not null, tags text not null,
        project text, source text, created text not null, updated text not null,
        mtime real not null, size integer not null, body text not null
      );
      create index notes_id on notes(id);
      create index notes_updated on notes(updated);
      create virtual table notes_fts using fts5(
        path unindexed, title, body, tags,
        tokenize = "unicode61 remove_diacritics 2"
      );
      pragma user_version = ${SCHEMA_VERSION};
    `);
  }

  // ---------- index ----------

  private listFiles(): string[] {
    const out: string[] = [];
    const walk = (abs: string, rel: string) => {
      for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
        if (e.name.startsWith(".") || e.name === "node_modules") continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(abs, e.name), r);
        else if (e.isFile() && e.name.endsWith(".md") && e.name.toLowerCase() !== "readme.md") out.push(r);
      }
    };
    walk(this.dir, "");
    return out;
  }

  private indexNote(n: Note, mtime: number, size: number) {
    this.db.prepare("delete from notes_fts where path = ?").run(n.path);
    this.db
      .prepare(
        `insert into notes (path, id, title, tags, project, source, created, updated, mtime, size, body)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(path) do update set id = excluded.id, title = excluded.title, tags = excluded.tags,
           project = excluded.project, source = excluded.source, created = excluded.created,
           updated = excluded.updated, mtime = excluded.mtime, size = excluded.size, body = excluded.body`,
      )
      .run(n.path, n.id, n.title, n.tags.join(" "), n.project, n.source, n.created, n.updated, mtime, size, n.body);
    this.db
      .prepare("insert into notes_fts (path, title, body, tags) values (?, ?, ?, ?)")
      .run(n.path, fold(n.title), fold(n.body), fold([...n.tags, n.project ?? ""].join(" ")));
  }

  private unindex(rel: string) {
    this.db.prepare("delete from notes where path = ?").run(rel);
    this.db.prepare("delete from notes_fts where path = ?").run(rel);
  }

  /** Brings the index in line with the files. Returns counts of what changed. */
  sync(force = false): { added: number; updated: number; removed: number } {
    const now = Date.now();
    if (!force && now - this.lastSync < 500) return { added: 0, updated: 0, removed: 0 };
    this.lastSync = now;
    const known = new Map<string, { mtime: number; size: number }>();
    for (const r of this.db.prepare("select path, mtime, size from notes").all() as {
      path: string;
      mtime: number;
      size: number;
    }[]) {
      known.set(r.path, { mtime: r.mtime, size: r.size });
    }
    let added = 0;
    let updated = 0;
    this.db.exec("begin");
    try {
      for (const rel of this.listFiles()) {
        const abs = path.join(this.dir, rel);
        let st: fs.Stats;
        try {
          st = fs.statSync(abs);
        } catch {
          continue;
        }
        const k = known.get(rel);
        known.delete(rel);
        if (k && k.mtime === st.mtimeMs && k.size === st.size) continue;
        const note = parseNote(fs.readFileSync(abs, "utf8"), rel, st.mtime);
        this.indexNote(note, st.mtimeMs, st.size);
        if (k) updated++;
        else added++;
      }
      for (const rel of known.keys()) this.unindex(rel);
      this.db.exec("commit");
    } catch (e) {
      this.db.exec("rollback");
      throw e;
    }
    return { added, updated, removed: known.size };
  }

  /** Drops the index and rebuilds it from the files. */
  reindex() {
    this.db.exec("delete from notes; delete from notes_fts;");
    return this.sync(true);
  }

  // ---------- read ----------

  private rowToNote(r: Record<string, unknown>): Note {
    return {
      id: String(r.id),
      title: String(r.title),
      body: String(r.body),
      tags: r.tags ? String(r.tags).split(" ").filter(Boolean) : [],
      project: (r.project as string | null) ?? null,
      source: (r.source as string | null) ?? null,
      created: String(r.created),
      updated: String(r.updated),
      path: String(r.path),
    };
  }

  private filterSql(f: Filter, alias = "n"): { sql: string; args: string[] } {
    const parts: string[] = [];
    const args: string[] = [];
    if (f.project) {
      parts.push(`lower(${alias}.project) = lower(?)`);
      args.push(f.project);
    }
    if (f.tag) {
      parts.push(`(' ' || ${alias}.tags || ' ') like ?`);
      args.push(`% ${normalizeTags([f.tag])[0] ?? f.tag} %`);
    }
    return { sql: parts.length ? " and " + parts.join(" and ") : "", args };
  }

  /** A note by id, by path, or by a unique id prefix (8+ characters). */
  get(idOrPath: string): Note | null {
    this.sync();
    const key = idOrPath.trim();
    let r = this.db.prepare("select * from notes where id = ? or path = ? limit 1").get(key, key);
    if (!r && key.length >= 8) {
      const rows = this.db.prepare("select * from notes where id like ? limit 2").all(`${key}%`);
      if (rows.length === 1) r = rows[0];
    }
    return r ? this.rowToNote(r as Record<string, unknown>) : null;
  }

  recent(limit = 10, f: Filter = {}): Hit[] {
    this.sync();
    const w = this.filterSql(f);
    const rows = this.db
      .prepare(`select * from notes n where 1 = 1${w.sql} order by n.updated desc limit ?`)
      .all(...w.args, limit) as Record<string, unknown>[];
    return rows.map((r) => this.toHit(this.rowToNote(r), []));
  }

  /**
   * Full-text search. First every word must match (as a prefix); if nothing does, any word stem may
   * match, so natural questions ("where did I park the car?") still find notes.
   */
  search(query: string, limit = 10, f: Filter = {}): Hit[] {
    this.sync();
    const tokens = queryTokens(query);
    if (!tokens.length) return this.recent(limit, f);
    const strict = tokens.map((t) => `"${t}"*`).join(" AND ");
    const loose = [...new Set(tokens.filter((t) => t.length >= 2).map(stem))].map((t) => `"${t}"*`).join(" OR ");
    for (const match of loose && loose !== strict ? [strict, loose] : [strict]) {
      const w = this.filterSql(f);
      const rows = this.db
        .prepare(
          `select n.* from notes_fts join notes n on n.path = notes_fts.path
            where notes_fts match ?${w.sql}
            order by bm25(notes_fts, 0, 10, 1, 4), n.updated desc limit ?`,
        )
        .all(match, ...w.args, limit) as Record<string, unknown>[];
      if (rows.length) return rows.map((r) => this.toHit(this.rowToNote(r), tokens));
    }
    return [];
  }

  private toHit(n: Note, tokens: string[]): Hit {
    const { body, ...rest } = n;
    return { ...rest, snippet: snippet(body, tokens) };
  }

  stats() {
    this.sync();
    const c = this.db.prepare("select count(*) as notes, max(updated) as last from notes").get() as {
      notes: number;
      last: string | null;
    };
    const projects = this.db
      .prepare("select project, count(*) as n from notes where project is not null group by project order by n desc")
      .all() as { project: string; n: number }[];
    return { ...c, projects };
  }

  // ---------- write ----------

  save(input: { content: string; title?: string; tags?: string[]; project?: string | null; source?: string | null }): Note {
    const body = input.content.trim();
    if (!body) throw new Error("content is empty");
    const now = new Date().toISOString();
    const title = input.title?.trim() || deriveTitle(body);
    const rel = newNotePath(this.dir, title, now);
    const note: Note = {
      id: ulid(),
      title,
      body,
      tags: normalizeTags(input.tags ?? []),
      project: input.project?.trim() || null,
      source: input.source?.trim() || null,
      created: now,
      updated: now,
      path: rel,
    };
    this.write(note);
    return note;
  }

  update(
    idOrPath: string,
    patch: { content?: string; append?: string; title?: string; tags?: string[]; project?: string | null },
  ): Note {
    const cur = this.get(idOrPath);
    if (!cur) throw new Error(`note not found: ${idOrPath}`);
    const next: Note = { ...cur };
    if (patch.content !== undefined) next.body = patch.content.trim();
    if (patch.append?.trim()) next.body = `${next.body.trimEnd()}\n\n${patch.append.trim()}`;
    if (patch.title !== undefined) next.title = patch.title.trim() || deriveTitle(next.body);
    if (patch.tags !== undefined) next.tags = normalizeTags(patch.tags);
    if (patch.project !== undefined) next.project = patch.project?.trim() || null;
    // A hand-written file without an id gets one the first time it is updated through notelog.
    if (next.id === next.path) next.id = ulid(Date.parse(next.created) || Date.now());
    next.updated = new Date().toISOString();
    this.write(next);
    return next;
  }

  private write(n: Note) {
    const abs = path.join(this.dir, n.path);
    const { path: _p, ...rest } = n;
    writeFileAtomic(abs, serializeNote(rest));
    const st = fs.statSync(abs);
    this.indexNote(n, st.mtimeMs, st.size);
  }
}

/** ~200 characters of the body around the first query match (or the start of the note). */
export function snippet(body: string, tokens: string[], width = 200): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat.length <= width) return flat;
  const folded = fold(flat);
  let at = -1;
  for (const t of tokens) {
    const i = folded.indexOf(stem(t));
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return flat.slice(0, width).trimEnd() + "…";
  const start = Math.max(0, at - Math.floor(width / 3));
  const end = Math.min(flat.length, start + width);
  return (start > 0 ? "…" : "") + flat.slice(start, end).trim() + (end < flat.length ? "…" : "");
}
