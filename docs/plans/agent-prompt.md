# Agent Prompt — Implement memrecall v1

## Context

You are implementing **memrecall** — an MCP server that gives AI assistants persistent long-term memory. The project is at `~/Desktop/vt7/memrecall/`.

## Instructions

### Step 1: Read these files in order

1. `docs/design.md` — Full design document. Understand every decision before writing code.
2. `docs/plans/2026-04-08-memrecall-v1.md` — Implementation plan with 9 tasks, complete code, and tests.
3. `docs/plans/bugfixes.md` — 10 bugs found during review. **Apply ALL fixes while implementing.** Do not implement the buggy version then fix — implement the correct version directly.

### Step 2: Implement task by task

Follow the plan (Tasks 1-9) in order. For each task:

1. Write tests first (if task has tests)
2. Run tests to verify they fail
3. Write implementation — **incorporating bugfixes from bugfixes.md**
4. Run tests to verify they pass
5. Commit

### Step 3: Key bugfixes to apply during implementation

These are the most important — do NOT skip:

- **Task 3 (memories.ts):** Use `result.lastInsertRowid` instead of `last_insert_rowid()` SQL function for FTS5 sync
- **Task 3 (memories.ts):** `normalizeProject` must return `null` (not empty string) for invalid input
- **Task 4 (search.test.ts):** ALL test queries with `OR` are wrong — FTS sanitizer wraps OR as literal. Fix every test query per bugfixes.md
- **Task 4 (search.ts):** `getTopMemories` must accept `projects: string[] | null` (not single project) and optional `type` filter
- **Task 5 (server.ts):** Verify `server.resource()` API signature against actual SDK. Pass `projects` array (not single project) to `getTopMemories`
- **Task 6 (index.ts):** `import` command must be wrapped in `db.transaction()`. Backup command must not double-close DB.
- **Task 9 (README):** Remove `--expired` flag from gc command

### Step 4: Verify before claiming done

```bash
pnpm test          # All tests pass
pnpm build         # TypeScript compiles
pnpm lint          # No type errors
```

Then manual test:
```bash
npm link
memrecall status
memrecall search "test"
```

## Important Notes

- All code and prompts in **English**
- Package name: `memrecall` (NOT `@vt7/recall`)
- DB path: `~/.memrecall/memrecall.db`
- Env var: `MEMRECALL_PROJECT`
- Tool names: `memrecall_remember`, `memrecall_recall`, `memrecall_update`, `memrecall_forget`, `memrecall_status`
- MCP Resource URI: `memrecall://context`
- CLI binary: `memrecall`
- Dependencies: `@modelcontextprotocol/sdk`, `better-sqlite3`, `nanoid`, `commander`, `zod`
- 5 runtime deps, 3 dev deps
- FTS5 tokenizer: `unicode61 remove_diacritics 2`
- SQLite: WAL mode + busy_timeout 5000ms
- Schema migration via `user_version` pragma
