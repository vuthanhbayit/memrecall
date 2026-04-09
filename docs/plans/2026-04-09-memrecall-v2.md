# memrecall v2 — Design & Implementation Plan

> **Status:** Implemented (2026-04-09). All 3 features complete, 95 tests passing.

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add 3 major features to memrecall: semantic search (vector embeddings), conversation mining, and knowledge graph.

**Current state:** v1 is complete — 6 source files, 31 tests, SQLite + FTS5, 5 MCP tools, CLI. See `docs/design.md`.

**v2 adds:**
1. **Semantic search** — hybrid FTS5 + vector embeddings with auto-fallback
2. **Conversation mining** — retroactive extraction from Claude Code / ChatGPT history
3. **Knowledge graph** — temporal entity-relationship triples

**Principle:** Each feature is opt-in or auto-detected. v1 behavior is always the fallback. Zero config required.

---

## Feature 1: Semantic Search

### How It Works

```
User saves memory: "Chose PostgreSQL for the persistence layer"
  → FTS5 index: keyword tokens (existing v1)
  → Embedding: [0.23, 0.87, 0.12, ...] (NEW — 384-dim vector)

User searches: "database decision"
  → FTS5: no keyword match → 0 results
  → Vector: cosine similarity 0.94 → FOUND
  → Hybrid merge: return best from both
```

### Embedding Provider — Auto-detection with Fallback

```
1. Check Ollama running? (localhost:11434)
   → Yes: use Ollama nomic-embed-text (768-dim, fast)
   → No: continue

2. Fallback: transformers.js
   → Auto-download all-MiniLM-L6-v2 first time (~23MB)
   → Run in-process, ~50ms per embedding

3. Both fail: FTS5-only (v1 behavior)
   → Log warning, continue working
```

User never configures anything. Just works.

### Schema Changes (migration v1 → v2)

```sql
-- v2 migration
ALTER TABLE memories ADD COLUMN embedding BLOB;

CREATE INDEX idx_embedding ON memories(embedding) WHERE embedding IS NOT NULL;
```

Embeddings stored as raw Float32Array BLOB in SQLite. No separate vector DB needed.

### Vector Search Implementation

SQLite does not have native vector similarity. Two options:

**Option A: Application-level cosine similarity**
```typescript
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

// Load all active embeddings, compute similarity, sort
// OK for <100k memories (memrecall's scale)
```

**Option B: sqlite-vec extension**
```typescript
// If available, use native vector search
// SELECT * FROM memories WHERE vec_distance(embedding, ?) < 0.5
```

**Decision: Start with Option A.** Application-level is simpler, zero dependencies, fast enough for our scale (<100k rows). Add sqlite-vec in v3 if needed.

### Hybrid Search — Merge Strategy

When query has both FTS5 and vector results:

```typescript
function hybridSearch(db, query, options) {
  // 1. FTS5 keyword search (existing)
  const ftsResults = ftsSearch(db, query, options)

  // 2. Vector search (new)
  const queryEmbedding = await embed(query)
  const vecResults = vectorSearch(db, queryEmbedding, options)

  // 3. Merge — Reciprocal Rank Fusion (RRF)
  // RRF score = sum(1 / (k + rank_in_each_list))
  // Simple, proven, no tuning needed
  return reciprocalRankFusion(ftsResults, vecResults, { k: 60 })
}
```

RRF (Reciprocal Rank Fusion) is the standard for merging ranked lists from different sources. Used by Elasticsearch, Meilisearch, etc. No magic thresholds to tune.

### Embedding on Save

```typescript
// In createMemory, after FTS5 sync:
const embedding = await embed(input.content)
if (embedding) {
  db.prepare('UPDATE memories SET embedding = ? WHERE id = ?')
    .run(Buffer.from(embedding.buffer), id)
}
```

If embedding fails (no Ollama, transformers.js not loaded) → memory is saved without embedding. FTS5 still works. No data loss.

### Backfill Existing Memories

```bash
memrecall embed                      # embed all memories without embeddings
memrecall embed --project owt        # embed specific project
memrecall embed --force              # re-embed all (when switching model)
```

### New Dependencies

```json
{
  "@xenova/transformers": "^3.0.0"   // local embedding fallback
}
```

Ollama is called via HTTP (fetch), no dependency needed.

### Files Changed/Created

```
src/
  embed.ts          # NEW — embedding provider (Ollama + transformers.js + fallback)
  search.ts         # MODIFIED — add vectorSearch, hybridSearch, reciprocalRankFusion
  memories.ts       # MODIFIED — embed on save
  db.ts             # MODIFIED — v2 migration (add embedding column)
  server.ts         # MODIFIED — pass embedding to search
  index.ts          # MODIFIED — add `memrecall embed` command

src/embed.test.ts   # NEW — embedding provider tests
src/search.test.ts  # MODIFIED — hybrid search tests
```

---

## Feature 2: Conversation Mining

### How It Works

```bash
memrecall mine ~/.claude                    # mine Claude Code conversations
memrecall mine ~/chatgpt-export.json        # mine ChatGPT export
memrecall mine ~/chats/ --format claude     # explicit format
memrecall mine ~/chats/ --dry-run           # preview without saving
memrecall mine ~/chats/ --project owt       # tag all mined memories
```

### Architecture — Pluggable Parsers

```typescript
// src/mining/parser.ts — interface
interface ConversationParser {
  name: string                              // 'claude-code' | 'chatgpt' | ...
  detect(path: string): Promise<boolean>    // can this parser handle this path?
  parse(path: string): AsyncIterable<Conversation>
}

interface Conversation {
  id: string
  messages: Message[]
  metadata?: { project?: string; date?: string }
}

interface Message {
  role: 'user' | 'assistant'
  content: string
  timestamp?: string
}
```

### Parsers Shipped in v2

**1. Claude Code Parser**

```
~/.claude/projects/
  -Users-admin-Desktop-think-owt-platform/
    conversations/
      abc123.jsonl     ← each line is a message
      def456.jsonl
```

Claude Code JSONL format: each line is JSON with `role`, `content`, `tool_use`, etc.

```typescript
// src/mining/claude-code-parser.ts
export class ClaudeCodeParser implements ConversationParser {
  name = 'claude-code'

  async detect(path: string): Promise<boolean> {
    // Check if path looks like ~/.claude or has conversations/*.jsonl
  }

  async *parse(path: string): AsyncIterable<Conversation> {
    // Find all .jsonl files
    // Parse each file as a conversation
    // Yield conversations
  }
}
```

**2. ChatGPT Parser**

ChatGPT export is single JSON file: `conversations.json` with array of conversations.

```typescript
// src/mining/chatgpt-parser.ts
export class ChatGPTParser implements ConversationParser {
  name = 'chatgpt'

  async detect(path: string): Promise<boolean> {
    // Check if file is conversations.json with ChatGPT structure
  }

  async *parse(path: string): AsyncIterable<Conversation> {
    // Read JSON, yield each conversation
  }
}
```

### Extraction Strategy

After parsing conversations, extract memories. Two modes:

**Mode A: Raw (default)** — save entire conversation as 1 memory per conversation.
```typescript
{
  type: 'context',
  content: summarizeConversation(messages),  // first 2000 chars or key messages
  tags: ['mined', 'claude-code'],
  project: detectedProject || userSpecified
}
```

**Mode B: Smart extract (--extract)** — use keyword patterns to classify.
```typescript
// Decision patterns
const DECISION_PATTERNS = [
  /(?:decided|chose|going with|chốt|quyết định)\s+(.+)/i,
  /(?:let's use|we'll use|switching to)\s+(.+)/i,
]

// Feedback patterns
const FEEDBACK_PATTERNS = [
  /(?:don't|never|stop|đừng|không bao giờ)\s+(.+)/i,
  /(?:always|luôn|prefer)\s+(.+)/i,
]

// Bug patterns
const BUG_PATTERNS = [
  /(?:root cause|failed because|lỗi vì|the issue was)\s+(.+)/i,
]
```

Extract matching sentences → create typed memories. No LLM call needed.

### Dedup During Mining

Mined memories can overlap with existing ones. Simple dedup:

```typescript
// Before saving mined memory, FTS5 search for similar content
// If top result has high word overlap (>70%) → skip
// This is acceptable for mining (bulk operation) vs real-time (where we skip dedup)
```

### MCP Tool — `memrecall_mine` (optional)

```typescript
{
  name: "memrecall_mine",
  description: `Mine conversation history to extract memories retroactively.
    Usually called via CLI, but AI can suggest: "You have unmined conversations, run memrecall mine."`,
  inputSchema: {
    path: z.string().describe("Path to conversations directory or file"),
    project: z.string().optional(),
    dryRun: z.boolean().optional().default(false),
  }
}
```

### Files Created

```
src/mining/
  parser.ts              # ConversationParser interface
  claude-code-parser.ts  # Claude Code JSONL parser
  chatgpt-parser.ts      # ChatGPT JSON parser
  extractor.ts           # Keyword-based memory extraction
  index.ts               # mine() orchestrator — detect format, parse, extract, save

src/mining/extractor.test.ts    # Extraction pattern tests
src/mining/claude-code.test.ts  # Parser tests with fixture data

src/index.ts             # MODIFIED — add `memrecall mine` command
src/server.ts            # MODIFIED — add `memrecall_mine` tool (optional)
```

---

## Feature 3: Knowledge Graph

### How It Works

```typescript
// AI saves structured facts during conversation
memrecall_kg_add({
  subject: "OWT",
  predicate: "uses",
  object: "Prisma 7",
  validFrom: "2026-01-01"
})

// AI queries facts
memrecall_kg_query({ entity: "OWT" })
// → [
//   { subject: "OWT", predicate: "uses", object: "Prisma 7", validFrom: "2026-01", validUntil: null },
//   { subject: "OWT", predicate: "uses", object: "Nuxt 4", validFrom: "2025-06", validUntil: null },
//   { subject: "Bay", predicate: "works_on", object: "OWT", validFrom: "2025-01", validUntil: null },
// ]

// Timeline
memrecall_kg_timeline({ entity: "OWT" })
// → chronological story of OWT

// Invalidate old fact
memrecall_kg_invalidate({
  subject: "OWT",
  predicate: "uses",
  object: "Prisma 5",
  ended: "2025-12-31"
})
```

### Schema (same SQLite DB, new table)

```sql
-- v2 migration (in addition to embedding column)
CREATE TABLE triples (
  id          TEXT PRIMARY KEY,
  subject     TEXT NOT NULL,
  predicate   TEXT NOT NULL,
  object      TEXT NOT NULL,
  project     TEXT,
  valid_from  TEXT NOT NULL,
  valid_until TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX idx_triples_subject ON triples(subject) WHERE valid_until IS NULL;
CREATE INDEX idx_triples_object ON triples(object) WHERE valid_until IS NULL;
CREATE INDEX idx_triples_project ON triples(project) WHERE valid_until IS NULL;
```

### Integration with Memory Search

When `memrecall_recall` is called, also search triples:

```typescript
// In search.ts — enhance recall results
function enhancedRecall(db, input) {
  const memories = searchMemories(db, input)  // existing

  // If query mentions known entities, include relevant triples
  const triples = searchTriples(db, input.query, input.projects)

  if (triples.length > 0) {
    // Append triple summary to results
    const tripleSummary = formatTriples(triples)
    return { memories, triples: tripleSummary }
  }

  return { memories, triples: null }
}
```

AI receives both memories (narrative) and triples (structured facts).

### MCP Tools — 3 new tools

```typescript
// Tool 6: memrecall_kg_add
{
  name: "memrecall_kg_add",
  description: `Save a structured fact as a knowledge graph triple.

CALL WHEN:
- Learning a concrete relationship ("X uses Y", "A works on B", "C depends on D")
- Technology choices, team assignments, project dependencies
- Facts that can be expressed as (subject, predicate, object)

DO NOT CALL WHEN:
- Opinions, preferences, rules → use memrecall_remember instead
- Vague context → use memrecall_remember instead`,

  inputSchema: {
    subject: z.string(),
    predicate: z.string(),
    object: z.string(),
    project: z.string().optional(),
  }
}

// Tool 7: memrecall_kg_query
{
  name: "memrecall_kg_query",
  description: `Query knowledge graph for facts about an entity.

CALL WHEN:
- Need to know relationships of a person, project, or technology
- "What does X use?", "Who works on Y?", "What depends on Z?"`,

  inputSchema: {
    entity: z.string().describe("Subject or object to query"),
    predicate: z.string().optional().describe("Filter by relationship type"),
    project: z.string().optional(),
    includeExpired: z.boolean().optional().default(false),
  }
}

// Tool 8: memrecall_kg_invalidate
{
  name: "memrecall_kg_invalidate",
  description: `Mark a triple as no longer valid. Sets valid_until.

CALL WHEN:
- A relationship has ended ("X no longer uses Y", "A left project B")`,

  inputSchema: {
    subject: z.string(),
    predicate: z.string(),
    object: z.string(),
  }
}
```

Total: 8 MCP tools (5 existing + 3 new). Still far less than MemPalace's 19.

### Files Created

```
src/
  kg.ts              # NEW — triples CRUD, query, timeline, invalidate
  kg.test.ts         # NEW — KG tests
  search.ts          # MODIFIED — enhancedRecall includes triples
  db.ts              # MODIFIED — v2 migration adds triples table
  server.ts          # MODIFIED — 3 new MCP tools
  index.ts           # MODIFIED — `memrecall kg` CLI subcommands
```

---

## v2 Migration Strategy

Single migration from v1 → v2 in `db.ts`:

```typescript
if (version < 2) {
  db.exec(`
    -- Semantic search
    ALTER TABLE memories ADD COLUMN embedding BLOB;
    CREATE INDEX idx_embedding ON memories(embedding) WHERE embedding IS NOT NULL;

    -- Knowledge graph
    CREATE TABLE triples (
      id          TEXT PRIMARY KEY,
      subject     TEXT NOT NULL,
      predicate   TEXT NOT NULL,
      object      TEXT NOT NULL,
      project     TEXT,
      valid_from  TEXT NOT NULL,
      valid_until TEXT,
      created_at  TEXT NOT NULL
    );

    CREATE INDEX idx_triples_subject ON triples(subject) WHERE valid_until IS NULL;
    CREATE INDEX idx_triples_object ON triples(object) WHERE valid_until IS NULL;
    CREATE INDEX idx_triples_project ON triples(project) WHERE valid_until IS NULL;
  `)
  db.pragma('user_version = 2')
}
```

Existing v1 users: `memrecall serve` → auto-migrates → v1 features keep working. Embeddings are null until `memrecall embed` is run. KG is empty until AI starts adding triples.

---

## Updated Package Structure

```
src/
  types.ts              # MODIFIED — add Triple, Embedding types
  db.ts                 # MODIFIED — v2 migration
  memories.ts           # MODIFIED — embed on save
  search.ts             # MODIFIED — hybrid search, enhanced recall
  server.ts             # MODIFIED — 3 new KG tools + mine tool
  index.ts              # MODIFIED — embed, mine, kg CLI commands
  embed.ts              # NEW — Ollama + transformers.js + fallback
  kg.ts                 # NEW — Knowledge graph CRUD
  mining/
    parser.ts           # NEW — ConversationParser interface
    claude-code-parser.ts  # NEW
    chatgpt-parser.ts      # NEW
    extractor.ts           # NEW — keyword extraction
    index.ts               # NEW — mine orchestrator
```

## Updated Dependencies

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "better-sqlite3": "^11.0.0",
    "nanoid": "^5.0.0",
    "commander": "^13.0.0",
    "zod": "^3.24.0",
    "@huggingface/transformers": "^3.0.0"
  }
}
```

`@huggingface/transformers` replaces `@xenova/transformers` (official package, same API). Lazy-loaded — only imported when embeddings are needed.

## CLI Commands (new)

```bash
# Semantic search (transparent — just works)
memrecall search "database decision"          # hybrid FTS5 + vector if available

# Embedding management
memrecall embed                               # backfill all memories without embeddings
memrecall embed --project owt                 # backfill specific project
memrecall embed --force                       # re-embed all
memrecall embed --status                      # show embedding coverage

# Conversation mining
memrecall mine ~/.claude                      # auto-detect format, mine all
memrecall mine ~/export.json --format chatgpt # explicit format
memrecall mine ~/.claude --project owt        # tag mined memories
memrecall mine ~/.claude --extract            # smart extraction (decisions, feedback, bugs)
memrecall mine ~/.claude --dry-run            # preview

# Knowledge graph
memrecall kg query OWT                        # all facts about OWT
memrecall kg timeline OWT                     # chronological
memrecall kg list --project owt               # all triples in project
```

---

## Implementation Order

| Task | Feature | Depends on | Est. |
|------|---------|------------|------|
| 1 | Schema migration v2 | — | 30min |
| 2 | Embedding provider (embed.ts) | — | 2-3h |
| 3 | Vector search + hybrid merge | Task 1, 2 | 2h |
| 4 | Embed on save + backfill CLI | Task 2, 3 | 1h |
| 5 | Knowledge graph CRUD (kg.ts) | Task 1 | 1-2h |
| 6 | KG MCP tools (3 tools) | Task 5 | 1h |
| 7 | Mining parser interface | — | 30min |
| 8 | Claude Code parser | Task 7 | 1-2h |
| 9 | ChatGPT parser | Task 7 | 1h |
| 10 | Extractor + mine orchestrator | Task 7, 8, 9 | 1-2h |
| 11 | Mine CLI + MCP tool | Task 10 | 1h |
| 12 | Integration tests | All | 1-2h |
| 13 | Update README + design doc | All | 30min |

Tasks 1-4 (semantic search), 5-6 (KG), 7-11 (mining) can be developed in parallel.

---

## Backwards Compatibility

- v1 memories without embeddings: FTS5 search still works, vector search skips them
- v1 users upgrading: auto-migration, run `memrecall embed` to backfill
- No embedding provider available: graceful fallback to FTS5-only
- KG empty: `memrecall_recall` returns only memories (no triples section)
- No breaking changes to v1 MCP tools or CLI commands
