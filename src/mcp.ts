// MCP server over stdio. The model does the thinking (titles, summaries, answers); notelog stores
// and finds notes. Tool descriptions are written for the model: they say when to call each tool.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Note } from "./notes.ts";
import { type Hit, Store } from "./store.ts";
import { VERSION } from "./version.ts";

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

function hitLine(h: Hit, i: number): string {
  const meta = [h.updated.slice(0, 10), h.project ? `project: ${h.project}` : "", h.tags.length ? `#${h.tags.join(" #")}` : ""]
    .filter(Boolean)
    .join(" · ");
  return `${i + 1}. ${h.title}  [id: ${h.id}]\n   ${meta}\n   ${h.snippet}`;
}

function hitList(hits: Hit[], empty: string): string {
  return hits.length ? hits.map(hitLine).join("\n\n") : empty;
}

function noteText(n: Note): string {
  const meta = [
    `id: ${n.id}`,
    `file: ${n.path}`,
    `created: ${n.created}`,
    `updated: ${n.updated}`,
    n.project ? `project: ${n.project}` : "",
    n.tags.length ? `tags: ${n.tags.join(", ")}` : "",
    n.source ? `source: ${n.source}` : "",
  ].filter(Boolean);
  return `# ${n.title}\n${meta.join("\n")}\n\n${n.body}`;
}

const project = z
  .string()
  .optional()
  .describe("Project or area this belongs to (for coding agents: the repository name). Omit for personal notes.");
const tags = z.array(z.string()).optional().describe("A few lowercase tags, e.g. [\"idea\", \"health\"].");

export function createServer(store: Store) {
  const server = new McpServer({ name: "notelog", version: VERSION });
  // Which app saved a note ("claude-code", "codex" ...), from the MCP handshake.
  let clientSource = "mcp";
  server.server.oninitialized = () => {
    const name = server.server.getClientVersion()?.name;
    if (name) clientSource = name.toLowerCase().replace(/\s+/g, "-").slice(0, 40);
  };

  server.registerTool(
    "save_note",
    {
      title: "Save a note",
      description:
        "Save something worth remembering beyond this conversation: a fact, a decision, a plan, a snippet, a " +
        "reference. Write the content so it stands alone later (who/what/why, concrete values). Search first " +
        "if a note on the same thing may exist and use update_note instead of creating a duplicate.",
      inputSchema: {
        content: z.string().min(1).describe("The note in Markdown. Self-contained."),
        title: z.string().optional().describe("Short, specific title. Defaults to the first line."),
        tags,
        project,
      },
    },
    async ({ content, title, tags, project }) => {
      const n = store.save({ content, title, tags, project, source: clientSource });
      return text(`Saved "${n.title}" [id: ${n.id}] to ${n.path}`);
    },
  );

  server.registerTool(
    "search_notes",
    {
      title: "Search notes",
      description:
        "Search the user's notes. Use it whenever the user refers to something they may have noted before, asks " +
        "\"what did I decide / where did I put / what was the …\", or before saving to avoid duplicates. Pass the " +
        "key words (names, nouns), not a full sentence. Results show id, title and a snippet; call get_note for the " +
        "full text. Answer from the notes and cite their titles.",
      inputSchema: {
        query: z.string().min(1).describe("Key words to look for."),
        limit: z.number().int().min(1).max(50).optional().describe("Default 10."),
        project: z.string().optional().describe("Only notes of this project."),
        tag: z.string().optional().describe("Only notes with this tag."),
      },
    },
    async ({ query, limit, project, tag }) =>
      text(hitList(store.search(query, limit ?? 10, { project, tag }), `No notes match "${query}".`)),
  );

  server.registerTool(
    "get_note",
    {
      title: "Read a note",
      description: "Return the full text of a note by its id (or file path).",
      inputSchema: { id: z.string().min(1) },
    },
    async ({ id }) => {
      const n = store.get(id);
      return n ? text(noteText(n)) : { ...text(`No note with id ${id}.`), isError: true };
    },
  );

  server.registerTool(
    "update_note",
    {
      title: "Update a note",
      description:
        "Change an existing note: append new information (preferred, keeps history readable), replace the whole " +
        "content, or change title/tags/project. Use it instead of saving a second note on the same subject.",
      inputSchema: {
        id: z.string().min(1),
        append: z.string().optional().describe("Text added to the end of the note."),
        content: z.string().optional().describe("Replaces the whole body. Include everything that should remain."),
        title: z.string().optional(),
        tags: tags.describe("Replaces the tag list."),
        project,
      },
    },
    async ({ id, ...patch }) => {
      try {
        const n = store.update(id, patch);
        return text(`Updated "${n.title}" [id: ${n.id}]`);
      } catch (e) {
        return { ...text((e as Error).message), isError: true };
      }
    },
  );

  server.registerTool(
    "recent_notes",
    {
      title: "Recent notes",
      description: "List the most recently changed notes, optionally for one project or tag.",
      inputSchema: {
        limit: z.number().int().min(1).max(50).optional().describe("Default 10."),
        project: z.string().optional(),
        tag: z.string().optional(),
      },
    },
    async ({ limit, project, tag }) => text(hitList(store.recent(limit ?? 10, { project, tag }), "No notes yet.")),
  );

  server.registerTool(
    "load_context",
    {
      title: "Load context",
      description:
        "Call once at the start of a session (or when switching to a project) to recall what is already known: " +
        "recent decisions, notes related to the topic and the latest notes. For coding agents pass the repository " +
        "name as project. Keep what you learn in mind; do not repeat it back to the user unless asked.",
      inputSchema: {
        project: z.string().optional().describe("Project / repository name."),
        topic: z.string().optional().describe("What the session is about, in a few words."),
      },
    },
    async ({ project, topic }) => {
      const f = { project };
      const seen = new Set<string>();
      const take = (hits: Hit[], n: number) => hits.filter((h) => !seen.has(h.path) && seen.add(h.path)).slice(0, n);
      const decisions = take(store.recent(30, { ...f, tag: "decision" }), 8);
      const related = topic ? take(store.search(topic, 15, f), 6) : [];
      const latest = take(store.recent(15, f), 6);
      const s = store.stats();
      const parts = [
        `notelog: ${s.notes} notes${project ? `, project "${project}"` : ""}.`,
        decisions.length ? `## Decisions\n${decisions.map(hitLine).join("\n\n")}` : "",
        related.length ? `## Related to "${topic}"\n${related.map(hitLine).join("\n\n")}` : "",
        latest.length ? `## Latest\n${latest.map(hitLine).join("\n\n")}` : "",
        !decisions.length && !related.length && !latest.length ? "Nothing saved yet for this context." : "",
      ];
      return text(parts.filter(Boolean).join("\n\n"));
    },
  );

  server.registerTool(
    "log_decision",
    {
      title: "Log a decision",
      description:
        "Record a decision that was just made (technical choice, plan, rule, preference) with the reason, so a " +
        "later session does not reopen it. Tagged \"decision\" and returned first by load_context.",
      inputSchema: {
        decision: z.string().min(1).describe("What was decided, in one or two sentences."),
        why: z.string().optional().describe("The reason / trade-off."),
        alternatives: z.string().optional().describe("Options considered and rejected."),
        project,
        tags,
      },
    },
    async ({ decision, why, alternatives, project, tags }) => {
      const body = [
        decision.trim(),
        why?.trim() ? `**Why:** ${why.trim()}` : "",
        alternatives?.trim() ? `**Alternatives considered:** ${alternatives.trim()}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      const n = store.save({
        content: body,
        title: `Decision: ${decision.trim().split("\n")[0].slice(0, 70)}`,
        tags: ["decision", ...(tags ?? [])],
        project,
        source: clientSource,
      });
      return text(`Logged decision [id: ${n.id}] to ${n.path}`);
    },
  );

  return server;
}

export async function runStdio(store: Store) {
  await createServer(store).connect(new StdioServerTransport());
  startAutoSync(store);
}

/**
 * If the user ran `notelog login`, keep the folder in sync with Cloud while the MCP server runs: once at start,
 * then every NOTELOG_SYNC_SECONDS (default 60). Errors go to stderr (the client's MCP log), never to the model.
 */
function startAutoSync(store: Store) {
  const every = Number(process.env.NOTELOG_SYNC_SECONDS ?? 60);
  if (!every) return;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const { loadCredentials, syncNow } = await import("./sync.ts");
      const creds = loadCredentials();
      if (creds) await syncNow(store, creds);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg !== "another sync is running") console.error(`notelog sync: ${msg}`);
    } finally {
      running = false;
    }
  };
  void tick();
  setInterval(tick, Math.max(every, 15) * 1000).unref();
}
