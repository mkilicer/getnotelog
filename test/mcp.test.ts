import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/mcp.ts";
import { Store } from "../src/store.ts";

describe("mcp", () => {
  let dir: string;
  let store: Store;
  let client: Client;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "notelog-mcp-"));
    store = new Store(dir);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createServer(store).connect(a);
    client = new Client({ name: "Claude Code", version: "1.0.0" });
    await client.connect(b);
  });
  after(async () => {
    await client.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text).join("\n"), isError: !!r.isError };
  };

  test("lists the tools", async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ["get_note", "load_context", "log_decision", "recent_notes", "save_note", "search_notes", "update_note"],
    );
  });

  test("save, search, get, update", async () => {
    const saved = await call("save_note", { content: "Deploy uses Dokploy on the Hetzner box", project: "notelog", tags: ["ops"] });
    const id = /id: ([0-9A-Z]{26})/.exec(saved.text)![1];
    assert.match((await call("search_notes", { query: "dokploy" })).text, new RegExp(id));
    assert.match((await call("search_notes", { query: "kubernetes" })).text, /No notes match/);

    await call("update_note", { id, append: "Backups nightly at 03:00" });
    const full = (await call("get_note", { id })).text;
    assert.match(full, /Backups nightly/);
    assert.match(full, /source: claude-code/);
    assert.equal((await call("get_note", { id: "nope" })).isError, true);
    assert.equal((await call("update_note", { id: "nope", append: "x" })).isError, true);
  });

  test("log_decision comes first in load_context", async () => {
    await call("log_decision", { decision: "Use SQLite FTS5 for local search", why: "zero native deps", project: "notelog" });
    await call("save_note", { content: "Unrelated grocery list", tags: ["home"] });
    const ctx = (await call("load_context", { project: "notelog", topic: "search" })).text;
    assert.match(ctx, /## Decisions\n1\. Decision: Use SQLite FTS5/);
    assert.doesNotMatch(ctx, /grocery/);
    const file = fs.readdirSync(dir).find((f) => f.includes("decision"))!;
    assert.match(fs.readFileSync(path.join(dir, file), "utf8"), /\*\*Why:\*\* zero native deps/);
  });
});
