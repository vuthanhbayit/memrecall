# memrecall — Design Document

> MCP server providing long-term memory for AI assistants. Auto-capture, fast search, zero external service dependency.

## Problem

AI assistants forget everything between conversations. Developers repeat context, re-explain decisions, and lose institutional knowledge. Existing solutions (MemPalace, Mem0, Letta) require external services, have buggy implementations, or use misleading benchmarks.

## Solution

A single npm package that gives any MCP-compatible AI assistant persistent memory. One DB file, one install command, works forever.

```bash
npm install -g memrecall
claude mcp add memrecall -- memrecall serve
# Done. AI remembers from now on.
```

## Core Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Storage | SQLite + FTS5 (`~/.memrecall/memrecall.db`) | Single file, zero config, millions of rows, <10ms search |
| Search | FTS5 full-text + combined ranking | No vector/embedding needed. FTS5 + metadata filtering proven sufficient (MemPalace's 96.6% was just ChromaDB FTS) |
| Integration | MCP protocol | Agnostic — Claude Code, Cursor, Windsurf, Copilot, any MCP client |
| Capture | Auto + explicit | AI auto-saves via tool descriptions. User can force save or forget |
| Language | TypeScript | Official MCP SDK, npm distribution, widest reach |
| Storage location | `~/.memrecall/memrecall.db` | Global, never in project directory. No git conflicts. Similar to `~/.claude/` pattern |
| Project scope | `project` TEXT field | Single DB, filter by project. No per-project DB files |
| FTS5 sync | Application-level | CRUD operations sync FTS5 index in same transaction. No SQLite triggers (avoids better-sqlite3 trigger bugs) |
| Schema migration | SQLite `user_version` pragma | Sequential if-version-less-than checks on every startup. Zero dependency |
| Context loading | Tool description hint | `memrecall_recall` description instructs AI to call at conversation start. No auto-inject (MCP resources are application-controlled, not auto-loaded) |

## Non-Goals (v1)

- Vector/semantic embeddings (FTS5 is sufficient for v1)
- Cloud sync or team sharing (export/import JSON for that)
- Knowledge graph / entity relationships
- Conversation mining (post-hoc parsing of chat logs)
- Compression / AAAK-style encoding
- Duplicate detection / auto-dedup (rely on tool description: "search before saving")

## Architecture

```
~/.memrecall/
  memrecall.db          # Single SQLite database (all projects, all memories)

MCP Client (Claude Code, Cursor, etc.)
    │
    ├─ On connect: loads tool descriptions into system prompt
    │  → AI sees memrecall_recall description: "call at START of every conversation"
    │  → AI calls memrecall_recall() → receives top memories (~200 tokens)
    │
    ├─ During conversation: AI calls Tools as needed
    │   memrecall_remember  → save new memory
    │   memrecall_recall    → search memories
    │   memrecall_update    → modify existing memory
    │   memrecall_forget    → mark memory as expired
    │   memrecall_status    → overview stats
    │
    └─ All operations hit single SQLite DB via MCP server process
```

## Schema

```sql
-- v1 schema
CREATE TABLE memories (
  id               TEXT PRIMARY KEY,   -- nanoid
  type             TEXT NOT NULL,      -- decision | feedback | bug | context | reference
  content          TEXT NOT NULL,      -- memory content (max 2000 chars, validated in app)
  weight           REAL NOT NULL,      -- auto-assigned from type, not user-set
  project          TEXT,               -- NULL = global, "owt" = project-specific (normalized: lowercase, trimmed, slug)
  tags             TEXT,               -- JSON array: ["inventory", "architecture"]
  valid_from       TEXT NOT NULL,      -- ISO 8601
  valid_until      TEXT,               -- NULL = still valid
  access_count     INTEGER NOT NULL DEFAULT 0,  -- times recalled
  last_accessed_at TEXT,               -- last recall timestamp
  created_at       TEXT NOT NULL       -- ISO 8601
);

-- Full-text search index (external content — synced via application code, NOT triggers)
CREATE VIRTUAL TABLE memories_fts USING fts5(
  content,
  tags,                                -- space-separated (not JSON) for proper tokenization
  content='memories',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'  -- multilingual + diacritics normalization
);

-- Indexes
CREATE INDEX idx_project_valid ON memories(project, valid_until) WHERE valid_until IS NULL;
CREATE INDEX idx_created_at ON memories(created_at);
```

### SQLite Configuration

```typescript
// Applied on every DB open
db.pragma('journal_mode = WAL')     // concurrent reads during writes
db.pragma('busy_timeout = 5000')    // wait 5s instead of failing on lock
```

### Schema Migration

```typescript
function migrate(db: Database) {
  const version = db.pragma('user_version', { simple: true }) as number

  if (version < 1) {
    db.exec(/* CREATE TABLE memories, memories_fts, indexes */)
    db.pragma('user_version = 1')
  }

  if (version < 2) {
    // Future: e.g. ALTER TABLE memories ADD COLUMN source TEXT
    db.pragma('user_version = 2')
  }
}
```

Runs on every `memrecall serve` or CLI command. Auto-upgrades silently.

### FTS5 Sync (Application-Level)

Every CRUD operation syncs FTS5 index within the same transaction:

```typescript
function createMemory(data: CreateMemoryInput) {
  return db.transaction(() => {
    const result = db.prepare(
      'INSERT INTO memories (id, type, content, weight, project, tags, valid_from, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(data.id, data.type, data.content, data.weight, data.project, JSON.stringify(data.tags), data.validFrom, data.createdAt)

    db.prepare(
      'INSERT INTO memories_fts (rowid, content, tags) VALUES (last_insert_rowid(), ?, ?)'
    ).run(data.content, (data.tags || []).join(' '))

    return result
  })()
}

function updateMemory(id: string, content: string) {
  return db.transaction(() => {
    const old = db.prepare('SELECT rowid, * FROM memories WHERE id = ?').get(id)

    db.prepare('UPDATE memories SET content = ? WHERE id = ?').run(content, id)

    // Delete old FTS entry, insert new
    db.prepare("INSERT INTO memories_fts (memories_fts, rowid, content, tags) VALUES ('delete', ?, ?, ?)").run(old.rowid, old.content, old.tags)
    db.prepare('INSERT INTO memories_fts (rowid, content, tags) VALUES (?, ?, ?)').run(old.rowid, content, (JSON.parse(old.tags) || []).join(' '))
  })()
}

function expireMemory(id: string) {
  return db.transaction(() => {
    const old = db.prepare('SELECT rowid, * FROM memories WHERE id = ?').get(id)

    db.prepare('UPDATE memories SET valid_until = ? WHERE id = ?').run(new Date().toISOString(), id)

    // Remove from FTS (expired memories should not appear in search)
    db.prepare("INSERT INTO memories_fts (memories_fts, rowid, content, tags) VALUES ('delete', ?, ?, ?)").run(old.rowid, old.content, old.tags)
  })()
}
```

### Type Weights (auto-assigned, not user-set)

| Type | Weight | Half-life (days) | Description |
|------|--------|-------------------|-------------|
| decision | 1.0 | 730 (2 years) | Architecture choices, tech decisions — decay slowly |
| feedback | 0.9 | 730 (2 years) | User preferences, corrections — rarely change |
| bug | 0.7 | 180 (6 months) | Root causes — lose relevance faster |
| reference | 0.6 | 365 (1 year) | Pointers to external resources |
| context | 0.5 | 180 (6 months) | General project info — decays fast |

### Input Validation

```typescript
// Project name normalization
function normalizeProject(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9-]/g, '-')
}

// Content validation
function validateContent(content: string): void {
  if (content.trim().length === 0) throw new Error('Content cannot be empty')
  if (content.length > 2000) throw new Error('Content exceeds 2000 character limit')
}
```

## Search & Ranking

### Combined Ranking Formula (FTS5 + Custom)

Two query paths:

**With query** — FTS5 relevance × custom scoring:

```sql
SELECT m.*, fts.rank AS fts_rank
FROM memories_fts fts
JOIN memories m ON m.rowid = fts.rowid
WHERE fts MATCH ?
  AND m.valid_until IS NULL
  AND (m.project = ? OR m.project IS NULL)
ORDER BY
  (fts.rank * -1)                                                   -- FTS5 BM25 relevance (negated: lower = better match)
  * m.weight                                                        -- type importance
  * (1.0 / (1 + (julianday('now') - julianday(m.created_at)) / ?))  -- freshness (half-life varies by type)
  * (1.0 + min(m.access_count, 10) * 0.1)                          -- usage boost
  DESC
LIMIT ?
```

**Without query** — custom scoring only (for initial context load):

```sql
SELECT * FROM memories
WHERE valid_until IS NULL
  AND (project = ? OR project IS NULL)
ORDER BY
  weight
  * (1.0 / (1 + (julianday('now') - julianday(created_at)) / ?))    -- half-life per type
  * (1.0 + min(access_count, 10) * 0.1)
  DESC
LIMIT 15
```

> **Note:** Ranking formula is initial design. Will be benchmarked and tuned with real data after launch.

### Multi-Project Search

```typescript
// Single project (default — uses MEMRECALL_PROJECT env var)
memrecall_recall({ query: "inventory" })
// → WHERE (project = 'owt' OR project IS NULL) AND valid_until IS NULL

// Multiple projects (explicit)
memrecall_recall({ query: "VAT pricing", projects: ["owt", "thinkpro-api"] })
// → WHERE (project IN ('owt', 'thinkpro-api') OR project IS NULL) AND valid_until IS NULL

// All projects
memrecall_recall({ query: "dayjs" })
// → WHERE valid_until IS NULL (no project filter when no default set)
```

Global memories (`project IS NULL`) always included in results.

### Access Tracking

Every `memrecall_recall` response updates `access_count` and `last_accessed_at` for returned memories. This feeds the ranking formula — memories that are actually useful float up naturally.

## MCP Tools

### 1. memrecall_remember

Save an important memory from the current conversation.

```typescript
{
  name: "memrecall_remember",
  description: `Save important information from this conversation as a long-term memory.

CALL WHEN:
- Design decisions ("decided to use X", "going with approach Y over Z")
- User feedback or preferences ("don't do X", "always Y", "I prefer Z")
- Root cause of complex bugs ("failed because X", "the issue was Y")
- Business rules or constraints ("X is not allowed when Y")
- Important project context (architecture, conventions, deadlines)

DO NOT CALL WHEN:
- Fixing typos, renaming variables, small routine changes
- Answering simple syntax questions
- Performing routine operations with no new insights
- Information already saved (search first with memrecall_recall)

BEFORE SAVING: Search existing memories for similar content with memrecall_recall.
If a similar memory exists, use memrecall_update instead of creating a duplicate.`,

  inputSchema: {
    type: "object",
    required: ["type", "content"],
    properties: {
      type:    { enum: ["decision", "feedback", "bug", "context", "reference"] },
      content: { type: "string", description: "The memory content. Be specific and include reasoning." },
      project: { type: "string", description: "Project identifier (lowercase slug). Omit for global memories." },
      tags:    { type: "array", items: { type: "string" }, description: "Optional categorization tags." }
    }
  }
}
```

### 2. memrecall_recall

Search memories from previous conversations.

```typescript
{
  name: "memrecall_recall",
  description: `Search long-term memories from previous conversations.

IMPORTANT: Call this tool at the START of every new conversation with no query
to load your long-term memory. This is essential — without it, you have no
memory of previous conversations.

ALSO CALL WHEN:
- Needing context about a topic being discussed
- User asks "what did we decide about X"
- Before making a decision (check if prior decision exists)
- User references previous work or conversations`,

  inputSchema: {
    type: "object",
    properties: {
      query:    { type: "string", description: "FTS search query. Omit to get top memories by score." },
      projects: { type: "array", items: { type: "string" }, description: "Filter by projects. Omit to use default project from MEMRECALL_PROJECT env." },
      type:     { enum: ["decision", "feedback", "bug", "context", "reference"], description: "Filter by memory type." },
      limit:    { type: "number", default: 10, description: "Max results to return." }
    }
  }
}
```

### 3. memrecall_update

Update an existing memory in-place.

```typescript
{
  name: "memrecall_update",
  description: `Update an existing memory's content. Use when information needs correction
or additional context, but the memory is still about the same topic.

For replaced decisions (e.g., "we used to do X, now doing Y"):
use memrecall_forget on the old memory, then memrecall_remember for the new one.`,

  inputSchema: {
    type: "object",
    required: ["id", "content"],
    properties: {
      id:      { type: "string", description: "Memory ID to update." },
      content: { type: "string", description: "Updated content." }
    }
  }
}
```

### 4. memrecall_forget

Mark a memory as no longer valid.

```typescript
{
  name: "memrecall_forget",
  description: `Mark a memory as expired. Does not delete — sets valid_until timestamp.
Expired memories no longer appear in search results.

CALL WHEN:
- User says "forget that", "that's no longer true"
- A decision has been reverted
- Information is confirmed outdated`,

  inputSchema: {
    type: "object",
    required: ["id"],
    properties: {
      id:     { type: "string", description: "Memory ID to expire." },
      reason: { type: "string", description: "Why this memory is no longer valid." }
    }
  }
}
```

### 5. memrecall_status

Get memory statistics overview.

```typescript
{
  name: "memrecall_status",
  description: "Get overview of stored memories: total count, breakdown by project and type.",

  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "Filter stats by project. Omit for all." }
    }
  }
}
```

## MCP Resource (Optional)

Resource is **not** relied upon for context loading (MCP resources are application-controlled and not auto-injected). The primary mechanism is the `memrecall_recall` tool description hint.

Resource is provided as a convenience for clients that support manual resource references (e.g., `@memrecall://context`):

```typescript
server.resource(
  "memrecall://context",
  "Top memories for the current project",
  async () => {
    const project = process.env.MEMRECALL_PROJECT
    const memories = getTopMemories(project, 15)
    return formatContext(memories)
  }
)
```

## Package Structure

```
memrecall/
├── src/
│   ├── index.ts           # CLI entry point (commander)
│   ├── server.ts          # MCP server setup (tools + resource)
│   ├── db.ts              # SQLite connection, WAL, migrations, FTS5 setup
│   ├── memories.ts        # CRUD operations with FTS5 sync in transactions
│   ├── search.ts          # FTS5 search + combined ranking formula
│   └── types.ts           # TypeScript type definitions
├── bin/
│   └── memrecall.js       # CLI binary entry
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── README.md
```

## Dependencies

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "better-sqlite3": "^11.0.0",
    "nanoid": "^5.0.0",
    "commander": "^13.0.0"
  },
  "devDependencies": {
    "typescript": "^5.9.0",
    "vitest": "^3.0.0",
    "@types/better-sqlite3": "^7.6.0"
  }
}
```

4 runtime dependencies.

## CLI Commands

```bash
# MCP server (primary usage)
memrecall serve                            # Start MCP server (stdio transport)

# Manual search
memrecall search "inventory"               # Search all projects
memrecall search "VAT" --project owt       # Search specific project
memrecall search "VAT" --projects owt,api  # Search multiple projects

# Status
memrecall status                           # Global stats
memrecall status --project owt             # Project stats

# Maintenance
memrecall gc --before 2025-01              # Remove expired memories older than date
memrecall export --project owt             # Export to JSON (backup/share)
memrecall import memories.json             # Import from JSON

# Debug
memrecall list --project owt --limit 20    # List recent memories
memrecall get mem_abc123                   # View specific memory
```

## Installation & Activation

```bash
# Install
npm install -g memrecall

# Claude Code
claude mcp add memrecall -e MEMRECALL_PROJECT=owt -- memrecall serve

# Cursor / Windsurf (settings.json)
{
  "mcpServers": {
    "memrecall": {
      "command": "memrecall",
      "args": ["serve"],
      "env": { "MEMRECALL_PROJECT": "owt" }
    }
  }
}
```

`MEMRECALL_PROJECT` is optional. When set, it becomes the default project for search. Tool params can always override it.

## DB File Permissions

```typescript
// On directory creation
fs.mkdirSync(dir, { mode: 0o700, recursive: true })  // owner-only access
```

Memory content may include architecture decisions, business rules, and other sensitive project information. The `~/.memrecall/` directory should be owner-readable only.

## Lessons From MemPalace

| MemPalace Mistake | How Recall Avoids It |
|--------------------|----------------------|
| Benchmark tested ChromaDB, not MemPalace | No synthetic benchmarks — test with real data |
| 19 MCP tools (AI wastes tokens choosing) | 5 tools with clear descriptions |
| CLI and MCP use different code paths | Single code path for all operations |
| `compress` feature was dead code | Ship only what works, cut the rest |
| ChromaDB crashes at 10k+ docs | SQLite handles millions natively |
| No `.gitignore` respect, config in project dir | Nothing in project directory |
| Search scores negative (wrong distance metric) | FTS5 built-in ranking, no metric confusion |
| Python + ChromaDB dependency | npm install, zero external service dependency |
| Resource auto-load assumption | Tool description hint (proven MCP pattern) |
| No schema migration strategy | `user_version` pragma from day one |

## Future Considerations (not v1)

- **Optional embeddings**: Add vector search via local model for semantic similarity (when FTS5 keyword matching isn't enough) -- **Implemented in v2**
- **Team sync**: `memrecall sync` via shared storage (S3, git-friendly JSON)
- **Web UI**: `memrecall ui` for browsing and managing memories visually
- **Conversation import**: Mine Claude Code / Cursor conversation history retroactively -- **Implemented in v2**
- **Batch operations**: `memrecall_remember_batch` for saving multiple memories in one call
- **Semantic search note**: v1 uses keyword search. Tip: include synonyms and context in memory content for better recall. Example: "Chose PostgreSQL (database selection) for persistence layer" — adding "database selection" helps FTS5 match that query.

---

## v2 Architecture

v2 adds three major features on top of the v1 foundation: **semantic search** (hybrid FTS5 + vector embeddings), **knowledge graph** (temporal entity-relationship triples), and **conversation mining** (retroactive extraction from chat history). All three are opt-in or auto-detected. v1 behavior is always the fallback. Zero config required.

### Schema v2 Changes

Schema migration from v1 to v2 runs automatically on startup via the existing `user_version` pragma pattern:

```sql
-- v2 migration (runs automatically when user_version < 2)

-- Semantic search: embedding vector stored as raw Float32Array BLOB
ALTER TABLE memories ADD COLUMN embedding BLOB;
CREATE INDEX idx_embedding ON memories(embedding) WHERE embedding IS NOT NULL;

-- Knowledge graph: temporal triples (subject -> predicate -> object)
CREATE TABLE triples (
  id          TEXT PRIMARY KEY,   -- nanoid(12)
  subject     TEXT NOT NULL,
  predicate   TEXT NOT NULL,      -- normalized: lowercase, trimmed
  object      TEXT NOT NULL,
  project     TEXT,               -- NULL = global
  valid_from  TEXT NOT NULL,      -- ISO 8601
  valid_until TEXT,               -- NULL = still valid
  created_at  TEXT NOT NULL       -- ISO 8601
);

CREATE INDEX idx_triples_subject ON triples(subject) WHERE valid_until IS NULL;
CREATE INDEX idx_triples_object ON triples(object) WHERE valid_until IS NULL;
CREATE INDEX idx_triples_project ON triples(project) WHERE valid_until IS NULL;
```

Existing v1 users: `memrecall serve` auto-migrates. Embeddings are `NULL` until `memrecall embed` is run or new memories are saved. KG `triples` table is empty until the AI starts adding facts.

### Embedding Provider Architecture

Embedding uses a **fallback chain** -- the first available provider wins. User never configures anything.

```
On first embed request (cached per process):
  1. Ollama running? (localhost:11434, 2s timeout)
     -> Yes: use Ollama all-minilm model (384-dim, fast, local)
     -> No: continue

  2. @huggingface/transformers installed? (optional npm dep)
     -> Yes: use all-MiniLM-L6-v2 (384-dim, ~50ms per embedding, in-process)
     -> No: continue

  3. Both fail: FTS5-only mode (v1 behavior)
     -> Log warning, continue working. No data loss.
```

Implementation details (`src/embed.ts`):

- **Ollama provider**: HTTP calls to `localhost:11434/api/embeddings`, model `all-minilm`. 2s detect timeout, 10s embed timeout.
- **Transformers provider**: Dynamic import of `@huggingface/transformers` (lazy-loaded, optional dependency). Uses `pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')` with mean pooling and normalization.
- **Provider caching**: Resolved once per process via `getProvider()`. Subsequent calls return cached result.
- **Buffer conversion**: Embeddings stored as raw `Float32Array` BLOB in SQLite. `embeddingToBuffer()` / `bufferToEmbedding()` handle conversion.
- **Cosine similarity**: Application-level computation. Simple dot-product / norm formula. Fast enough for <100k rows.
- **Dimension**: Fixed at 384 (both Ollama all-minilm and transformers all-MiniLM-L6-v2 produce 384-dim vectors).

### Hybrid Search Flow

When a query is submitted, memrecall runs both FTS5 and vector search in parallel, then merges results:

```
User query: "database decision"
  |
  +---> FTS5 Search (existing v1)
  |       sanitize query -> BM25 ranking -> scored results
  |       May find 0 results if no keyword match
  |
  +---> Vector Search (v2)
  |       embed(query) -> cosine similarity vs all stored embeddings
  |       Finds semantically similar content even without keyword overlap
  |
  v
Reciprocal Rank Fusion (RRF, k=60)
  FTS5 results scored by rank position: 1/(k + rank + 1)
  Vector results scored by rank position: 1/(k + rank + 1)
  Overlapping results: scores are summed
  |
  v
Final merged results (sorted by combined RRF score)
```

**Three merge cases** (`src/search.ts`):
1. Both FTS5 and vector have results: merge via RRF, take top N
2. Only vector has results (keyword miss, semantic hit): return vector results
3. Only FTS5 has results (no embeddings available): return FTS5 results (v1 fallback)

RRF is the industry standard for merging ranked lists from different sources (used by Elasticsearch, Meilisearch). No magic thresholds to tune.

**Embed on save**: When a memory is created via `createMemoryWithEmbedding()`, the embedding is computed and stored in the same transaction. If embedding fails, the memory is saved without it (FTS5 still works).

### Knowledge Graph Design

The knowledge graph stores structured facts as **temporal triples** (subject, predicate, object) with validity tracking.

**Schema**: `triples` table (see Schema v2 Changes above).

**Key design decisions**:
- **Temporal validity**: `valid_from` / `valid_until` tracks when facts become true or are invalidated. Old facts are not deleted, just marked ended.
- **Deduplication**: `addTriple()` checks for existing active duplicate (same subject + predicate + object + not expired) before inserting. Returns existing triple if found.
- **Predicate normalization**: Predicates are lowercased and trimmed for consistent querying.
- **Bidirectional query**: `queryTriples()` searches both `subject` and `object` columns for the given entity.
- **LIKE-based search**: `searchTriplesByQuery()` uses case-insensitive `LIKE` matching on subject and object, not FTS5 (triples are short structured strings, not prose).

**Integration with memory search**: When `memrecall_recall` is called with a query, it also calls `searchTriplesByQuery()`. If matching triples are found, they are appended to the response under a `--- Knowledge Graph ---` section. The AI receives both narrative memories and structured facts.

**MCP tools**: 3 new tools:
- `memrecall_kg_add` -- save a triple (dedup-aware)
- `memrecall_kg_query` -- query facts by entity, with optional predicate/project filter
- `memrecall_kg_invalidate` -- mark a triple as ended (sets `valid_until`)

**CLI commands**:
- `memrecall kg query <entity>` -- all facts about an entity
- `memrecall kg timeline <entity>` -- chronological history (ordered by `valid_from ASC`)
- `memrecall kg list` -- all active triples (ordered by `created_at DESC`)

### Conversation Mining Architecture

Mining retroactively extracts memories from existing conversation history. Architecture is based on a **pluggable parser interface**.

**Parser interface** (`src/mining/types.ts`):

```typescript
interface ConversationParser {
  name: string                              // 'claude-code' | 'chatgpt' | ...
  detect(path: string): Promise<boolean>    // can this parser handle this path?
  parse(path: string): AsyncIterable<Conversation>
}

interface Conversation {
  id: string
  messages: Message[]
  metadata?: { project?: string; date?: string; source?: string }
}
```

**Shipped parser: Claude Code** (`src/mining/claude-code-parser.ts`):
- Detects `~/.claude` directories or any directory containing `.jsonl` files
- Recursively finds all `.jsonl` files
- Parses each file as a conversation (each line is a JSON message with `type`, `text`/`content`)
- Auto-detects project name from path (e.g., `~/.claude/projects/-Users-admin-Desktop-owt-platform/` yields `owt-platform`)

**Extractor** (`src/mining/extractor.ts`) -- two modes:

- **Raw mode** (default): Summarizes entire conversation into 1 memory per conversation. Takes first user message + first assistant response, truncated to 2000 chars.
- **Smart extract mode** (`--extract`): Scans all messages with keyword patterns to classify:
  - **Decision patterns**: "decided", "chose", "going with", "let's use", "chot", "quyet dinh" (Vietnamese)
  - **Feedback patterns**: "don't", "never", "stop", "always prefer", "dung", "khong bao gio" (Vietnamese)
  - **Bug patterns**: "root cause", "failed because", "loi vi", "nguyen nhan" (Vietnamese)

**Deduplication**: Before saving a mined memory, FTS5 searches for similar content. If any existing memory has >70% word overlap, the mined memory is skipped.

**Mining flow** (`src/mining/index.ts`):
1. Detect format: try each parser's `detect()`, use first match
2. Parse conversations via parser (async iterable)
3. For each conversation, extract memories (raw or smart mode)
4. Dedup check against existing memories
5. Save via `createMemory()`
6. Return stats: `{ parsed, extracted, saved, skipped }`

### Updated Package Structure

```
memrecall/
  src/
    index.ts              # CLI entry point (commander) — all commands including embed, mine, kg
    server.ts             # MCP server setup (9 tools + resource)
    db.ts                 # SQLite connection, WAL, migrations (v1 + v2)
    memories.ts           # CRUD operations with FTS5 sync + embedding on save
    search.ts             # Hybrid search (FTS5 + vector + RRF), enhanced recall with KG
    types.ts              # TypeScript types (Memory, Triple, EmbeddingProvider, etc.)
    embed.ts              # Embedding provider (Ollama + transformers.js fallback chain)
    kg.ts                 # Knowledge graph CRUD (add, query, invalidate, timeline, search)
    mining/
      types.ts            # ConversationParser, Conversation, Message, MineResult interfaces
      index.ts            # mine() orchestrator — detect, parse, extract, dedup, save
      claude-code-parser.ts  # Claude Code JSONL parser (recursive .jsonl finder)
      extractor.ts        # Keyword-based extraction (decision/feedback/bug patterns)
      extractor.test.ts   # Extractor pattern tests
    embed.test.ts         # Embedding provider tests
    search.test.ts        # Hybrid search + RRF tests
    kg.test.ts            # Knowledge graph tests
    memories.test.ts      # Memory CRUD tests
    db.test.ts            # Database + migration tests
    integration.test.ts   # End-to-end integration tests
  bin/
    memrecall.js          # CLI binary entry
  package.json
  tsconfig.json
  vitest.config.ts
  README.md
```

19 source files total (6 original v1 + 13 new for v2).

### Updated Dependencies

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "better-sqlite3": "^11.0.0",
    "nanoid": "^5.0.0",
    "commander": "^13.0.0",
    "zod": "^3.24.0"
  },
  "optionalDependencies": {
    "@huggingface/transformers": "^3.0.0"
  },
  "devDependencies": {
    "typescript": "^5.9.0",
    "vitest": "^3.0.0",
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^22.0.0"
  }
}
```

5 runtime dependencies (added `zod` in v2). `@huggingface/transformers` is optional -- if not installed, embedding falls back to Ollama or FTS5-only mode.

### Updated MCP Tools (9 total)

| # | Tool | Description | v1/v2 |
|---|------|-------------|-------|
| 1 | `memrecall_remember` | Save a memory (now with auto-embedding) | v1 (enhanced) |
| 2 | `memrecall_recall` | Search memories (now hybrid search + KG triples) | v1 (enhanced) |
| 3 | `memrecall_update` | Update a memory's content | v1 |
| 4 | `memrecall_forget` | Mark a memory as expired | v1 |
| 5 | `memrecall_status` | Memory statistics overview | v1 |
| 6 | `memrecall_kg_add` | Save a knowledge graph triple | v2 |
| 7 | `memrecall_kg_query` | Query facts about an entity | v2 |
| 8 | `memrecall_kg_invalidate` | Mark a triple as no longer valid | v2 |
| 9 | `memrecall_mine` | Mine conversation history for memories | v2 |
