import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { parseNote, slugify, ulid } from "../src/notes.ts";
import { Store, fold, queryTokens } from "../src/store.ts";

const dirs: string[] = [];
function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notelog-test-"));
  dirs.push(dir);
  return new Store(dir);
}
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

// sync() is throttled to once per 500 ms; tests that change files by hand force it.
const fresh = (s: Store) => s.sync(true);

describe("notes", () => {
  test("ulid is 26 chars and time sortable", () => {
    const a = ulid(1_700_000_000_000);
    const b = ulid(1_700_000_000_001);
    assert.equal(a.length, 26);
    assert.ok(a < b);
  });

  test("slugify folds Turkish letters", () => {
    assert.equal(slugify("Ödeme kararı: Polar mı, Stripe mı?"), "odeme-karari-polar-mi-stripe-mi");
    assert.equal(slugify("!!!"), "note");
  });

  test("file without frontmatter is a note", () => {
    const n = parseNote("# Shopping\n\nmilk, eggs", "list.md", new Date("2026-01-02T00:00:00Z"));
    assert.equal(n.id, "list.md");
    assert.equal(n.title, "Shopping");
    assert.equal(n.created, "2026-01-02T00:00:00.000Z");
  });

  test("fold keeps length and maps dotless i", () => {
    const s = "IĞDIR ılık İstanbul";
    assert.equal(fold(s).length, s.length);
    assert.equal(fold("ılık"), "ilik");
  });

  test("question words are dropped from queries", () => {
    assert.deepEqual(queryTokens("Arabayı nereye park etmiştim?"), ["arabayi", "park", "etmiştim"].map(fold));
  });
});

describe("store", () => {
  test("save writes a Markdown file and get reads it back", () => {
    const s = tmpStore();
    const n = s.save({ content: "Kombi servisi telefonu 0212 555 00 00", tags: ["Ev", "ev"], project: "home" });
    const file = fs.readFileSync(path.join(s.dir, n.path), "utf8");
    assert.match(file, /^---\nid: [0-9A-Z]{26}\ntitle: Kombi servisi telefonu 0212 555 00 00\ntags: \[ ev \]\nproject: home/);
    assert.equal(s.get(n.id)?.body, "Kombi servisi telefonu 0212 555 00 00");
    assert.equal(s.get(n.id.slice(0, 12))?.id, n.id);
    assert.equal(s.get(n.path)?.id, n.id);
  });

  test("search: all words first, then stems for natural questions", () => {
    const s = tmpStore();
    s.save({ content: "Arabayı AVM otoparkında B2 katına park ettim, 14 numaralı sütun." });
    s.save({ content: "Park yerinde bisiklet kilidi şifresi 4821" });
    s.save({ content: "Payments: chose Polar over Stripe because of merchant of record." });

    const strict = s.search("otopark B2");
    assert.equal(strict.length, 1);
    assert.match(strict[0].snippet, /B2/);

    const q = s.search("Arabayı nereye park etmiştim?");
    assert.ok(q.length >= 1);
    assert.match(q[0].title, /Arabayı/);

    assert.match(s.search("what did we decide about payments")[0].title, /Payments/);
    assert.equal(s.search("ISTANBUL").length, 0);
    assert.equal(s.search("arabayi")[0]?.title.startsWith("Arabayı"), true, "dotless i folds both ways");
  });

  test("filters by project and tag", () => {
    const s = tmpStore();
    s.save({ content: "use pnpm", project: "api", tags: ["tooling"] });
    s.save({ content: "use npm", project: "web", tags: ["tooling"] });
    assert.equal(s.search("use", 10, { project: "API" }).length, 1);
    assert.equal(s.recent(10, { tag: "tooling" }).length, 2);
    assert.equal(s.recent(10, { project: "web", tag: "tooling" })[0].snippet, "use npm");
  });

  test("hand-made changes in the folder are picked up", () => {
    const s = tmpStore();
    const n = s.save({ content: "first version" });
    fs.writeFileSync(path.join(s.dir, "manual.md"), "# Written by hand\n\nzebra crossing notes");
    fs.mkdirSync(path.join(s.dir, "sub"));
    fs.writeFileSync(path.join(s.dir, "sub", "deep.md"), "giraffe");
    fresh(s);
    assert.equal(s.search("zebra")[0].title, "Written by hand");
    assert.equal(s.search("giraffe")[0].path, "sub/deep.md");

    const file = path.join(s.dir, n.path);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll("first version", "second version"));
    fresh(s);
    assert.equal(s.get(n.id)?.body, "second version");

    fs.rmSync(file);
    fresh(s);
    assert.equal(s.get(n.id), null);
    assert.equal(s.search("version").length, 0);
  });

  test("update appends, replaces and gives hand-made notes an id", () => {
    const s = tmpStore();
    const n = s.save({ content: "Plan: A", title: "Plan" });
    s.update(n.id, { append: "Then B" });
    assert.equal(s.get(n.id)?.body, "Plan: A\n\nThen B");
    s.update(n.id, { content: "Plan: C", tags: ["x"] });
    const u = s.get(n.id)!;
    assert.equal(u.body, "Plan: C");
    assert.deepEqual(u.tags, ["x"]);
    assert.equal(u.title, "Plan");
    assert.ok(u.updated >= u.created);

    fs.writeFileSync(path.join(s.dir, "hand.md"), "no frontmatter here");
    fresh(s);
    const h = s.update("hand.md", { append: "more" });
    assert.match(h.id, /^[0-9A-Z]{26}$/);
    assert.match(fs.readFileSync(path.join(s.dir, "hand.md"), "utf8"), /^---\nid: /);
  });

  test("index can be deleted and rebuilt from the files", () => {
    const s = tmpStore();
    s.save({ content: "alpha note" });
    s.save({ content: "beta note" });
    const dir = s.dir;
    s.close();
    fs.rmSync(path.join(dir, ".notelog"), { recursive: true });
    const s2 = new Store(dir);
    dirs.push(dir);
    assert.equal(s2.search("beta").length, 1);
    assert.equal(s2.stats().notes, 2);
    s2.close();
  });

  test("1,000 notes: search under 100 ms", () => {
    const s = tmpStore();
    const words = "kahve deniz proje ödeme sunucu araba kitap toplantı müşteri fatura plan karar".split(" ");
    for (let i = 0; i < 1000; i++) {
      const pick = (k: number) => words[(i * 7 + k * 3) % words.length];
      s.save({ content: `Not ${i}: ${pick(1)} ${pick(2)} ${pick(3)} hakkında ayrıntılar. ${"lorem ipsum ".repeat(30)}` });
    }
    fresh(s);
    const t = performance.now();
    for (let i = 0; i < 20; i++) s.search(`${words[i % words.length]} ${words[(i + 5) % words.length]}`, 10);
    const per = (performance.now() - t) / 20;
    assert.ok(per < 100, `search took ${per.toFixed(1)} ms`);

    const t2 = performance.now();
    s.sync(true);
    assert.ok(performance.now() - t2 < 300, "no-change sync of 1,000 files is fast");
  });
});
