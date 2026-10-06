// Two-way sync between the local folder and notelog Cloud (getnotelog.com) over /api/v1/sync.
//
// The server keeps a version per note (a global counter that grows on every write) and tombstones for deleted
// notes. Locally, <dir>/.notelog/sync.json remembers the last pulled version (cursor) and, per note, the server
// version and a content hash as of the last sync. With that:
//   - local change   = hash now differs from the recorded hash (or the note is new);
//   - remote change  = it shows up in a pull after the cursor;
//   - both changed   = conflict: the server copy wins the original file, the local text is kept as a separate
//                      "(conflict ...)" note that is pushed like any new note. Nothing is overwritten silently.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Note, deriveTitle, writeFileAtomic } from "./notes.ts";
import type { Store } from "./store.ts";
import { VERSION } from "./version.ts";

export const DEFAULT_SERVER = "https://getnotelog.com";

export type Credentials = { server: string; token: string };

type Remote = {
  id: string;
  version: number;
  deleted: boolean;
  title?: string;
  content?: string;
  tags?: string[];
  project?: string | null;
  source?: string | null;
  created_at?: string;
  updated_at?: string;
};

type State = { server: string; cursor: number; notes: Record<string, { version: number; hash: string }> };

export type SyncReport = { pulled: number; pushed: number; deleted: number; conflicts: string[]; errors: string[] };

// ---------- credentials ----------

function credentialsFile() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "notelog", "credentials.json");
}

export function loadCredentials(): Credentials | null {
  const envToken = process.env.NOTELOG_TOKEN?.trim();
  if (envToken) return { server: process.env.NOTELOG_SERVER?.trim() || DEFAULT_SERVER, token: envToken };
  try {
    const c = JSON.parse(fs.readFileSync(credentialsFile(), "utf8")) as Credentials;
    return c.token ? { server: c.server || DEFAULT_SERVER, token: c.token } : null;
  } catch {
    return null;
  }
}

export function saveCredentials(c: Credentials) {
  const file = credentialsFile();
  writeFileAtomic(file, JSON.stringify(c, null, 2) + "\n");
  fs.chmodSync(file, 0o600);
}

export function clearCredentials(): boolean {
  try {
    fs.rmSync(credentialsFile());
    return true;
  } catch {
    return false;
  }
}

// ---------- http ----------

async function api<T>(c: Credentials, method: "GET" | "POST", pathAndQuery: string, body?: unknown): Promise<T> {
  const res = await fetch(new URL(pathAndQuery, c.server), {
    method,
    headers: {
      authorization: `Bearer ${c.token}`,
      "content-type": "application/json",
      "user-agent": `notelog/${VERSION}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 401) throw new Error("Cloud rejected the token (401). Run: notelog login");
  if (res.status === 402) throw new Error(`Sync is part of notelog Cloud: ${new URL("/billing", c.server)}`);
  if (!res.ok) throw new Error(`Cloud ${method} ${pathAndQuery}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Checks that the token works. Returns the number of notes in Cloud's first page (for messages). */
export async function verify(c: Credentials): Promise<number> {
  const r = await api<{ changes: Remote[] }>(c, "GET", "/api/v1/sync?since=0&limit=1000");
  return r.changes.filter((x) => !x.deleted).length;
}

// ---------- helpers ----------

export function noteHash(n: Pick<Note, "title" | "body" | "tags" | "project">): string {
  return createHash("sha256")
    .update(JSON.stringify([n.title.trim(), n.body.trim(), [...n.tags].sort(), n.project ?? ""]))
    .digest("hex");
}

function remoteToNote(r: Remote): Omit<Note, "path"> {
  const body = (r.content ?? "").trim();
  const now = new Date().toISOString();
  return {
    id: r.id,
    title: r.title?.trim() || deriveTitle(body),
    body,
    tags: r.tags ?? [],
    project: r.project ?? null,
    source: r.source ?? null,
    created: r.created_at ?? now,
    updated: r.updated_at ?? now,
  };
}

function stateFile(store: Store) {
  return path.join(store.dir, ".notelog", "sync.json");
}

function loadState(store: Store, server: string): State {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(store), "utf8")) as State;
    if (s.server === server && s.notes) return s;
  } catch {
    // no state yet
  }
  return { server, cursor: 0, notes: {} };
}

function saveState(store: Store, s: State) {
  writeFileAtomic(stateFile(store), JSON.stringify(s) + "\n");
}

/** One sync at a time per folder (the MCP server and the CLI may both try). Stale locks expire after 2 min. */
function lock(store: Store): () => void {
  const file = path.join(store.dir, ".notelog", "sync.lock");
  try {
    if (Date.now() - fs.statSync(file).mtimeMs > 120_000) fs.rmSync(file, { force: true });
  } catch {
    // no lock
  }
  try {
    fs.writeFileSync(file, String(process.pid), { flag: "wx" });
  } catch {
    throw new Error("another sync is running");
  }
  return () => fs.rmSync(file, { force: true });
}

// ---------- sync ----------

export async function syncNow(store: Store, c: Credentials): Promise<SyncReport> {
  const unlock = lock(store);
  try {
    return await run(store, c);
  } finally {
    unlock();
  }
}

async function run(store: Store, c: Credentials, round = 0): Promise<SyncReport> {
  const report: SyncReport = { pulled: 0, pushed: 0, deleted: 0, conflicts: [], errors: [] };
  const state = loadState(store, c.server);

  // Hand-written files get a real id before their first sync.
  for (const n of store.all()) if (n.id === n.path) store.update(n.path, {});

  const local = () => new Map(store.all().map((n) => [n.id, n]));
  const changedLocally = (n: Note) => noteHash(n) !== state.notes[n.id]?.hash;

  /** Server copy wins the id; a differing local text survives as a new "(conflict)" note. */
  const takeRemote = (r: Remote, mine: Note | undefined) => {
    const theirs = remoteToNote(r);
    if (mine && noteHash(mine) !== noteHash(theirs)) {
      const copy = store.save({
        content: mine.body,
        title: `${mine.title} (conflict ${new Date().toISOString().slice(0, 16).replace("T", " ")})`,
        tags: mine.tags,
        project: mine.project,
        source: mine.source,
      });
      report.conflicts.push(copy.path);
    }
    const written = store.put(theirs);
    state.notes[r.id] = { version: r.version, hash: noteHash(written) };
  };

  // 1. Pull everything after the cursor.
  let mine = local();
  for (;;) {
    const page = await api<{ changes: Remote[]; cursor: number; more: boolean }>(
      c,
      "GET",
      `/api/v1/sync?since=${state.cursor}&limit=500`,
    );
    for (const r of page.changes) {
      const n = mine.get(r.id);
      const known = state.notes[r.id];
      if (r.deleted) {
        if (n && known && !changedLocally(n)) {
          store.remove(r.id);
          report.deleted++;
        }
        // Edited here after it was deleted there: keep it; with no state it is pushed again as new.
        delete state.notes[r.id];
        continue;
      }
      if (known && known.version === r.version) continue; // our own earlier push
      if (n && known && !changedLocally(n)) {
        store.put(remoteToNote(r));
        state.notes[r.id] = { version: r.version, hash: noteHash(store.get(r.id)!) };
      } else if (n && noteHash(n) === noteHash(remoteToNote(r))) {
        state.notes[r.id] = { version: r.version, hash: noteHash(n) };
        continue;
      } else {
        takeRemote(r, n);
      }
      report.pulled++;
    }
    state.cursor = page.cursor;
    saveState(store, state);
    if (!page.more) break;
  }

  // 2. Push local changes: new, edited, deleted.
  mine = local();
  const changes: Record<string, unknown>[] = [];
  for (const n of mine.values()) {
    if (!changedLocally(n)) continue;
    changes.push({
      id: n.id,
      base_version: state.notes[n.id]?.version ?? null,
      title: n.title,
      content: n.body,
      tags: n.tags,
      project: n.project,
      source: n.source,
      created_at: n.created,
    });
  }
  for (const [id, s] of Object.entries(state.notes)) {
    if (!mine.has(id)) changes.push({ id, base_version: s.version, deleted: true });
  }

  const conflictsBeforePush = report.conflicts.length;
  for (let i = 0; i < changes.length; i += 100) {
    const batch = changes.slice(i, i + 100);
    const { results } = await api<{
      results: { id: string; status: string; version: number | null; note?: Remote; error?: string }[];
    }>(c, "POST", "/api/v1/sync", { changes: batch });
    for (const r of results) {
      const sent = batch.find((b) => b.id === r.id);
      if (r.status === "ok") {
        if (sent?.deleted) delete state.notes[r.id];
        else {
          const n = store.get(r.id);
          if (n && r.version !== null) state.notes[r.id] = { version: r.version, hash: noteHash(n) };
        }
        report.pushed++;
      } else if (r.status === "conflict" && r.note) {
        // Deleted here but changed there: bring the server copy back. Edited on both sides: conflict copy.
        takeRemote({ ...r.note, deleted: false }, sent?.deleted ? undefined : store.get(r.id) ?? undefined);
        report.pulled++;
      } else {
        report.errors.push(`${r.id}: ${r.error ?? r.status}`);
      }
    }
    saveState(store, state);
  }

  // Conflict copies made while pushing are new local notes; one more round uploads them.
  if (round === 0 && report.conflicts.length > conflictsBeforePush) {
    const again = await run(store, c, 1);
    report.pushed += again.pushed;
    report.errors.push(...again.errors);
  }
  return report;
}
