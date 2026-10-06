import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { Store } from "../src/store.ts";
import { syncNow } from "../src/sync.ts";

// A tiny in-memory version of Cloud's /api/v1/sync with the same rules (versions, tombstones, conflicts).
type Row = { id: string; version: number; deleted: boolean; title: string; content: string; tags: string[]; project: string | null };
function fakeCloud(token: string) {
  let seq = 0;
  const rows = new Map<string, Row>();
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) return res.writeHead(401).end();
    const url = new URL(req.url!, "http://x");
    const send = (o: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(o));
    if (req.method === "GET") {
      const since = Number(url.searchParams.get("since") ?? 0);
      const changes = [...rows.values()].filter((r) => r.version > since).sort((a, b) => a.version - b.version);
      return send({ changes, cursor: changes.at(-1)?.version ?? since, more: false });
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const results = [];
    for (const c of JSON.parse(raw).changes) {
      const cur = rows.get(c.id);
      const live = cur && !cur.deleted ? cur : undefined;
      if (live && (c.base_version === null || live.version !== c.base_version)) {
        results.push({ id: c.id, status: "conflict", version: live.version, note: live });
      } else if (c.deleted) {
        if (live) rows.set(c.id, { ...live, deleted: true, version: ++seq });
        results.push({ id: c.id, status: "ok", version: null });
      } else {
        const r = { id: c.id, version: ++seq, deleted: false, title: c.title, content: c.content, tags: c.tags ?? [], project: c.project ?? null };
        rows.set(c.id, r);
        results.push({ id: c.id, status: "ok", version: r.version });
      }
    }
    send({ results });
  });
  return { server, rows, webEdit: (id: string, content: string) => rows.set(id, { ...rows.get(id)!, content, version: ++seq }) };
}

describe("sync", () => {
  const token = "nl_pat_test";
  const cloud = fakeCloud(token);
  const dirs: string[] = [];
  let creds: { server: string; token: string };
  const folder = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "notelog-sync-"));
    dirs.push(d);
    return new Store(d);
  };
  const bodies = (s: Store) => s.all().map((n) => n.body).sort();

  before(async () => {
    await new Promise<void>((r) => cloud.server.listen(0, "127.0.0.1", r));
    creds = { server: `http://127.0.0.1:${(cloud.server.address() as AddressInfo).port}`, token };
  });
  after(() => {
    cloud.server.close();
    dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  });

  test("two folders converge; conflicts keep both texts; deletes propagate", async () => {
    const a = folder();
    const b = folder();
    const n1 = a.save({ content: "phone 111", tags: ["home"] });
    const n2 = a.save({ content: "to delete" });
    assert.equal((await syncNow(a, creds)).pushed, 2);
    assert.equal((await syncNow(b, creds)).pulled, 2);
    assert.deepEqual(bodies(b), bodies(a));
    assert.deepEqual(b.get(n1.id)?.tags, ["home"]);

    // Same note edited in both folders: A syncs first and wins the id; B keeps its text as a conflict copy.
    a.update(n1.id, { content: "phone 222 (A)" });
    b.update(n1.id, { content: "phone 333 (B)" });
    await syncNow(a, creds);
    const rb = await syncNow(b, creds);
    assert.equal(rb.conflicts.length, 1);
    await syncNow(a, creds);
    assert.deepEqual(bodies(a), ["phone 222 (A)", "phone 333 (B)", "to delete"]);
    assert.deepEqual(bodies(b), bodies(a));

    // Delete in A reaches B.
    a.remove(n2.id);
    await syncNow(a, creds);
    assert.equal((await syncNow(b, creds)).deleted, 1);
    assert.equal(b.get(n2.id), null);

    // Edit made in Cloud (web) arrives; nothing left to do afterwards.
    cloud.webEdit(n1.id, "phone 444 (web)");
    await syncNow(a, creds);
    assert.equal(a.get(n1.id)?.body, "phone 444 (web)");
    const idle = await syncNow(a, creds);
    assert.deepEqual([idle.pulled, idle.pushed, idle.deleted], [0, 0, 0]);
  });

  test("hand-written files get an id and sync; lost state does not duplicate", async () => {
    const a = folder();
    fs.writeFileSync(path.join(a.dir, "manual.md"), "written by hand");
    a.sync(true);
    await syncNow(a, creds);
    assert.match(fs.readFileSync(path.join(a.dir, "manual.md"), "utf8"), /^---\nid: /);

    fs.rmSync(path.join(a.dir, ".notelog", "sync.json"));
    const before = a.all().length;
    const r = await syncNow(a, creds);
    assert.equal(r.conflicts.length, 0);
    assert.equal(a.all().length, before);
  });

  test("bad token is reported", async () => {
    await assert.rejects(syncNow(folder(), { ...creds, token: "nl_pat_wrong" }), /401/);
  });
});
