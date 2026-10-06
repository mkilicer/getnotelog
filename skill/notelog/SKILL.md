---
name: notelog
description: Long-term memory across sessions through the notelog MCP tools. Use at the start of a session to load context, whenever the user asks about something they may have noted or decided before, and whenever a decision, fact, preference or plan worth keeping comes up (save it without being asked twice).
---

# notelog: memory that outlives the conversation

The notelog MCP server stores notes as Markdown files the user owns (`~/notelog`). You decide what is worth
keeping and how to phrase it; notelog stores and finds it. Tools: `load_context`, `search_notes`, `get_note`,
`save_note`, `update_note`, `log_decision`, `recent_notes`.

## At the start of a session

Call `load_context` once, before the first substantial answer.

- Coding agent in a repository: pass `project` = the repository name (folder name), and `topic` = the task in a
  few words.
- General chat: pass `topic` if the first message has one; otherwise call it with no arguments.

Use what comes back silently. Do not summarize it to the user unless they ask; just do not contradict a recorded
decision without saying so.

## When to look things up

Call `search_notes` before answering when the user:

- refers to the past ("what did we decide about…", "where did I put…", "what was the…", "like last time");
- asks about their own facts (accounts, addresses, settings, names, numbers, preferences);
- is about to repeat work that may already be documented.

Search with key words (names, nouns), not the whole sentence. If the first search misses, try once more with
other words. Open the best hits with `get_note` when the snippet is not enough. Answer from the notes and name
the note titles you used. If nothing is found, say so; never invent a note.

## When to save

Save when something would be useful in a later session and is not obvious from the code or the conversation
history:

- a **decision** with its reason: use `log_decision` (it is tagged `decision` and comes first in `load_context`);
- a fact the user told you about themselves, their setup, their project or their preferences;
- a plan, a list of next steps, a non-obvious fix, a command or configuration that took effort to find;
- anything the user says to remember ("remember this", "note that", "kaydet", "not al").

Do not save: small talk, things already in the repository (code, README, commit history), secrets (passwords,
API keys, tokens; if the user insists, say that notes are plain files on disk), or a copy of something already
saved.

Save proactively: when one of the cases above happens, save it and mention it in one short line ("Saved to
notelog: …"). Do not ask for permission each time unless the user asked you to.

## How to write a note

- **Self-contained.** The reader is you in a month, without this conversation. Name the project, the people, the
  versions, the concrete values. "We chose X" is useless; "Payments: chose Polar over Stripe because …" is not.
- **Title:** short and specific, the words someone would search for.
- **Body:** Markdown, the essentials first, then details. Keep the user's language.
- **Tags:** one to three lowercase words. **Project:** the repository name for code work; omit for personal notes.

## Avoid duplicates

Before `save_note`, run `search_notes` with the title words. If a note on the same subject exists, call
`update_note` with `append` (new facts, dated if useful) or `content` (when the old text is now wrong) instead of
creating a second note.
