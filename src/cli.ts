#!/usr/bin/env node
// notelog command line: `notelog mcp` runs the MCP server (what AI clients start); the other commands are
// for people: set up, search from the terminal, check the installation.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// node:sqlite prints an ExperimentalWarning on some Node versions; it is noise for users and MCP logs.
const emit = process.emitWarning.bind(process);
process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
  const msg = typeof w === "string" ? w : w.message;
  if (/SQLite/i.test(msg)) return;
  return (emit as (...a: unknown[]) => void)(w, ...rest);
}) as typeof process.emitWarning;

const { Store, defaultDir } = await import("./store.ts");
const { VERSION } = await import("./version.ts");

const HELP = `notelog ${VERSION}: memory for your AI, kept as Markdown files.

Usage:
  notelog init [--claude] [--codex]   Create the notes folder, install the Claude skill, show setup
  notelog mcp                         Run the MCP server on stdio (started by your AI client)
  notelog search <words>              Search notes
  notelog recent [n]                  Latest notes
  notelog add <text>                  Save a note from the terminal
  notelog reindex                     Rebuild the search index from the files
  notelog doctor                      Check the installation

Notes folder: ${defaultDir()}  (set NOTELOG_DIR to change it)`;

const SKILL_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "skill", "notelog", "SKILL.md");
const MCP_CMD = ["npx", "-y", "notelog", "mcp"];

const [cmd = "help", ...args] = process.argv.slice(2);

function has(bin: string): boolean {
  return spawnSync(process.platform === "win32" ? "where" : "which", [bin], { stdio: "ignore" }).status === 0;
}

function printHits(hits: { id: string; title: string; updated: string; snippet: string; path: string }[]) {
  if (!hits.length) return console.log("No notes found.");
  for (const h of hits) {
    console.log(`\x1b[1m${h.title}\x1b[0m  \x1b[2m${h.updated.slice(0, 10)} · ${h.path}\x1b[0m`);
    console.log(`  ${h.snippet}\n`);
  }
}

function installSkill(): string | null {
  const claudeDir = path.join(os.homedir(), ".claude");
  if (!fs.existsSync(claudeDir)) return null;
  const dest = path.join(claudeDir, "skills", "notelog", "SKILL.md");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(SKILL_SRC, dest);
  return dest;
}

function addTo(client: "claude" | "codex") {
  const argv =
    client === "claude"
      ? ["mcp", "add", "--scope", "user", "notelog", "--", ...MCP_CMD]
      : ["mcp", "add", "notelog", "--", ...MCP_CMD];
  if (!has(client)) return console.log(`  ${client}: not found on PATH, skipped.`);
  const r = spawnSync(client, argv, { stdio: "inherit" });
  console.log(r.status === 0 ? `  ${client}: notelog added.` : `  ${client}: "${client} ${argv.join(" ")}" failed.`);
}

switch (cmd) {
  case "mcp": {
    const { runStdio } = await import("./mcp.ts");
    await runStdio(new Store());
    break;
  }
  case "init": {
    const store = new Store();
    const readme = path.join(store.dir, "README.md");
    if (!fs.existsSync(readme)) {
      fs.writeFileSync(
        readme,
        "# notelog\n\nYour notes, one Markdown file each. Edit, move or delete them freely; notelog re-reads the folder.\n" +
          "The `.notelog/` folder is only a search index and can be deleted.\n",
      );
    }
    const s = store.stats();
    console.log(`Notes folder: ${store.dir} (${s.notes} notes)`);
    const skill = installSkill();
    console.log(skill ? `Claude skill installed: ${skill}` : "Claude skill: ~/.claude not found, skipped.");
    if (args.includes("--claude")) addTo("claude");
    if (args.includes("--codex")) addTo("codex");
    console.log(`
Connect your AI client:

  Claude Code   claude mcp add --scope user notelog -- ${MCP_CMD.join(" ")}
  Codex         codex mcp add notelog -- ${MCP_CMD.join(" ")}
  Cursor / Claude Desktop / others, in the MCP config:
                { "mcpServers": { "notelog": { "command": "npx", "args": ["-y", "notelog", "mcp"] } } }

For Codex and Cursor, also add the instructions from ${SKILL_SRC}
to AGENTS.md or your rules so the agent knows when to save and search.`);
    store.close();
    break;
  }
  case "search": {
    if (!args.length) {
      console.error("Usage: notelog search <words>");
      process.exit(1);
    }
    const store = new Store();
    printHits(store.search(args.join(" "), 10));
    store.close();
    break;
  }
  case "recent": {
    const store = new Store();
    printHits(store.recent(Number(args[0]) || 10));
    store.close();
    break;
  }
  case "add": {
    const content = args.join(" ").trim() || (process.stdin.isTTY ? "" : fs.readFileSync(0, "utf8"));
    if (!content.trim()) {
      console.error("Usage: notelog add <text>   (or pipe text in)");
      process.exit(1);
    }
    const store = new Store();
    const n = store.save({ content, source: "cli" });
    console.log(`Saved "${n.title}" to ${n.path}`);
    store.close();
    break;
  }
  case "reindex": {
    const store = new Store();
    const t = performance.now();
    const r = store.reindex();
    console.log(`Indexed ${r.added} notes in ${Math.round(performance.now() - t)} ms.`);
    store.close();
    break;
  }
  case "doctor": {
    const ok = (b: boolean, label: string, extra = "") => console.log(`${b ? "ok  " : "FAIL"}  ${label}${extra ? `  (${extra})` : ""}`);
    const [major, minor] = process.versions.node.split(".").map(Number);
    ok(major > 22 || (major === 22 && minor >= 13), "Node.js >= 22.13", process.versions.node);
    try {
      const store = new Store();
      const t = performance.now();
      store.sync(true);
      const s = store.stats();
      ok(true, "Notes folder", `${store.dir}, ${s.notes} notes`);
      ok(true, "Search index", `synced in ${Math.round(performance.now() - t)} ms`);
      const q = performance.now();
      store.search("test", 10);
      ok(true, "Full-text search (SQLite FTS5)", `${Math.round(performance.now() - q)} ms`);
      store.close();
    } catch (e) {
      ok(false, "Notes folder / index", (e as Error).message);
    }
    const skill = path.join(os.homedir(), ".claude", "skills", "notelog", "SKILL.md");
    ok(fs.existsSync(skill), "Claude skill", fs.existsSync(skill) ? skill : "run: notelog init");
    if (has("claude")) {
      const r = spawnSync("claude", ["mcp", "get", "notelog"], { encoding: "utf8" });
      ok(r.status === 0, "Claude Code MCP", r.status === 0 ? "registered" : "run: notelog init --claude");
    }
    break;
  }
  case "-v":
  case "--version":
  case "version":
    console.log(VERSION);
    break;
  default:
    console.log(HELP);
}
