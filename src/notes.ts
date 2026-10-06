// Notes are plain Markdown files with a small YAML frontmatter. The files are the source of truth;
// the SQLite index (index.ts) can always be rebuilt from them.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

export type Note = {
  id: string;
  title: string;
  body: string;
  tags: string[];
  project: string | null;
  source: string | null;
  created: string;
  updated: string;
  /** Path relative to the notes directory, with forward slashes. */
  path: string;
};

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** ULID: sortable by creation time, safe in file names and URLs. */
export function ulid(time = Date.now()): string {
  let t = time;
  let head = "";
  for (let i = 0; i < 10; i++) {
    head = ENCODING[t % 32] + head;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let tail = "";
  for (let i = 0; i < 16; i++) tail += ENCODING[bytes[i] % 32];
  return head + tail;
}

const FOLD: Record<string, string> = { ı: "i", İ: "i", ğ: "g", ü: "u", ş: "s", ö: "o", ç: "c" };

export function slugify(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[ıİğüşöç]/g, (c) => FOLD[c] ?? c)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return s || "note";
}

/** Title from the first non-empty line, without Markdown heading marks. */
export function deriveTitle(body: string): string {
  const line = body.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const clean = line.replace(/^#+\s*/, "").replace(/\s+/g, " ");
  return clean.length > 80 ? clean.slice(0, 77).trimEnd() + "..." : clean || "Untitled";
}

export function normalizeTags(tags: unknown): string[] {
  const list = Array.isArray(tags) ? tags : typeof tags === "string" ? tags.split(",") : [];
  const out: string[] = [];
  for (const t of list) {
    const v = String(t).trim().replace(/^#/, "").toLowerCase();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

const FM = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Parses a note file. Files without frontmatter are valid notes too (id falls back to the path). */
export function parseNote(text: string, relPath: string, mtime: Date): Note {
  let meta: Record<string, unknown> = {};
  let body = text;
  const m = FM.exec(text);
  if (m) {
    try {
      const parsed = YAML.parse(m[1]);
      if (parsed && typeof parsed === "object") meta = parsed as Record<string, unknown>;
    } catch {
      // Broken frontmatter: keep the whole file as body rather than losing it.
    }
    body = text.slice(m[0].length);
  }
  body = body.replace(/^\s*\n/, "").trimEnd();
  const str = (v: unknown) => (v === undefined || v === null || v === "" ? null : String(v));
  const date = (v: unknown) => (v instanceof Date ? v.toISOString() : str(v));
  return {
    id: str(meta.id) ?? relPath,
    title: str(meta.title) ?? deriveTitle(body),
    body,
    tags: normalizeTags(meta.tags),
    project: str(meta.project),
    source: str(meta.source),
    created: date(meta.created) ?? mtime.toISOString(),
    updated: date(meta.updated) ?? mtime.toISOString(),
    path: relPath,
  };
}

export function serializeNote(n: Omit<Note, "path">): string {
  const meta: Record<string, unknown> = { id: n.id, title: n.title };
  if (n.tags.length) meta.tags = n.tags;
  if (n.project) meta.project = n.project;
  if (n.source) meta.source = n.source;
  meta.created = n.created;
  meta.updated = n.updated;
  const doc = new YAML.Document(meta);
  const tagNode = doc.get("tags", true);
  if (YAML.isSeq(tagNode)) tagNode.flow = true; // tags: [a, b] on one line
  const fm = doc.toString({ lineWidth: 0 }).trimEnd();
  return `---\n${fm}\n---\n\n${n.body.trimEnd()}\n`;
}

/** Picks a free file name like 2026-10-06-payments-decision.md (with -2, -3 ... on collision). */
export function newNotePath(dir: string, title: string, created: string): string {
  const base = `${created.slice(0, 10)}-${slugify(title)}`;
  for (let i = 1; ; i++) {
    const name = i === 1 ? `${base}.md` : `${base}-${i}.md`;
    if (!fs.existsSync(path.join(dir, name))) return name;
  }
}

/** Writes atomically (temp file + rename) so a crash never leaves a half-written note. */
export function writeFileAtomic(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, file);
}
