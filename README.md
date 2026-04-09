<p align="center">
  <h1 align="center">memrecall</h1>
  <p align="center">
    <strong>Your AI never forgets again.</strong>
    <br />
    Long-term memory for AI assistants — one install, works forever.
  </p>
</p>

<p align="center">
  <a href="#install">Install</a> &bull;
  <a href="#how-it-works">How It Works</a> &bull;
  <a href="#features">Features</a> &bull;
  <a href="#cli">CLI</a> &bull;
  <a href="#mcp-tools">MCP Tools</a>
</p>

---

Every conversation starts from zero. Your AI re-discovers the same codebase, re-asks the same questions, re-makes the same mistakes. **memrecall fixes that.**

One SQLite file. One install command. Your AI remembers decisions, preferences, bugs, and context — across every conversation, every project, forever.

```bash
npm install -g memrecall
claude mcp add memrecall -- memrecall serve
# Done. Your AI remembers from now on.
```

## Why memrecall?

| Problem | memrecall |
|---------|-----------|
| AI forgets everything between conversations | Persists memories in `~/.memrecall/memrecall.db` |
| Keyword search misses semantic matches | Hybrid FTS5 + vector search with auto-fallback |
| No structured knowledge | Knowledge graph with temporal triples |
| Past conversations are dead weight | Mine Claude Code history into searchable memories |
| Other tools need cloud APIs / vector DBs | Zero dependencies — just SQLite |
| MemPalace has 24 tools (AI wastes tokens choosing) | 9 focused tools with clear descriptions |

### Compared to alternatives

| | memrecall | MemPalace | Mem0 |
|---|:-:|:-:|:-:|
| Runtime | Node.js | Python | Python |
| Storage | SQLite (single file) | ChromaDB + SQLite | Cloud API |
| Search | Hybrid FTS5 + Vector | Vector only | Cloud embeddings |
| Fallback when offline | FTS5 keyword search | Broken | Broken |
| MCP tools | 9 | 24 | 5 |
| Embedding provider | Auto-detect (Ollama / local) | ChromaDB default | Cloud-only |
| Knowledge graph | Temporal triples | Temporal triples | No |
| Conversation mining | Claude Code JSONL | Raw chunking | No |
| Install size (base) | ~15 MB | ~500 MB+ | Cloud service |
| Config required | Zero | Palace setup | API key |

## Install

```bash
npm install -g memrecall
```

### Optional: Semantic Search

Embeddings work automatically if either is available:

1. **Ollama** (recommended for speed) — `ollama pull all-minilm` + have Ollama running
2. **@huggingface/transformers** (no server needed) — `npm install -g @huggingface/transformers`

Neither available? memrecall falls back to FTS5 keyword search. No errors, no data loss — just slightly less magic.

## Setup

**Claude Code:**

```bash
claude mcp add memrecall -e MEMRECALL_PROJECT=myproject -- memrecall serve
```

**Cursor / Windsurf / any MCP client:**

```json
{
  "mcpServers": {
    "memrecall": {
      "command": "memrecall",
      "args": ["serve"],
      "env": { "MEMRECALL_PROJECT": "myproject" }
    }
  }
}
```

`MEMRECALL_PROJECT` is optional — sets the default project filter for search.

## How It Works

```
Conversation 1                    Conversation 2
┌─────────────────────┐          ┌─────────────────────┐
│ AI: "Let's use       │          │ AI calls recall()    │
│  PostgreSQL for..."  │          │   ↓                  │
│                      │          │ "You decided to use  │
│ → memrecall_remember │────────→ │  PostgreSQL because  │
│   saves decision     │  SQLite  │  of X, Y, Z."       │
└─────────────────────┘          └─────────────────────┘
```

1. **Conversation starts** → AI calls `memrecall_recall` (tool description tells it to)
2. **During conversation** → AI saves decisions, feedback, bugs via `memrecall_remember`
3. **Next conversation** → memories are there, ranked by relevance + freshness + usage
4. **Everything stored** in `~/.memrecall/memrecall.db` — one file, backs up trivially

## Features

### Hybrid Search

FTS5 keyword matching + vector cosine similarity, merged via [Reciprocal Rank Fusion](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf):

```
Memory: "Chose PostgreSQL for the persistence layer"

Search: "database decision"
  → FTS5: no keyword match (0 results)
  → Vector: cosine similarity 0.94 (FOUND)
  → RRF merge: returns the memory ✓
```

Two search backends are better than one — FTS5 catches exact terms, vectors catch meaning.

### Knowledge Graph

Structured facts with temporal tracking. AI saves relationships, queries them later:

```
memrecall_kg_add("OWT", "uses", "Prisma 7")
memrecall_kg_add("OWT", "uses", "Nuxt 4")
memrecall_kg_add("Bay", "works_on", "OWT")

memrecall_kg_query("OWT")
  → OWT → uses → Prisma 7 (since 2026-01)
  → OWT → uses → Nuxt 4 (since 2025-06)
  → Bay → works_on → OWT (since 2025-01)
```

When you search memories, relevant knowledge graph facts are **automatically appended** — no extra tool call needed.

Facts can be invalidated when things change (`memrecall_kg_invalidate`), preserving history while keeping current results clean.

### Conversation Mining

Your past Claude Code conversations contain gold — decisions, preferences, lessons learned. Mining extracts them:

```bash
memrecall mine ~/.claude --project myproject           # 1 memory per conversation
memrecall mine ~/.claude --project myproject --extract  # smart: find decisions/feedback/bugs
memrecall mine ~/.claude --dry-run                      # preview first
```

Smart extraction finds patterns like:
- **Decisions**: "decided to use X", "going with Y", "let's use Z"
- **Feedback**: "don't ever do X", "always prefer Y"
- **Bugs**: "root cause was X", "failed because Y"

Built-in dedup (>70% word overlap) prevents importing what you already know.

### Graceful Degradation

Every feature degrades gracefully. Nothing breaks:

| Condition | Behavior |
|-----------|----------|
| No Ollama, no transformers.js | FTS5 keyword search (v1 behavior) |
| Memory has no embedding | Skipped in vector search, found via FTS5 |
| Knowledge graph empty | `recall` returns only memories |
| No conversations to mine | Nothing mined, no error |
| DB is v1 | Auto-migrates to v2 on startup |

## Memory Types & Ranking

| Type | Weight | Half-life | Use case |
|------|:------:|:---------:|----------|
| `decision` | 1.0 | 2 years | Architecture choices, tech decisions |
| `feedback` | 0.9 | 2 years | User preferences, corrections |
| `bug` | 0.7 | 6 months | Root causes of complex bugs |
| `reference` | 0.6 | 1 year | Pointers to external resources |
| `context` | 0.5 | 6 months | General project information |

Ranking formula: `FTS5_BM25 × weight × freshness_decay × usage_boost`

Frequently recalled memories float up naturally. Old bugs sink. Decisions persist.

## MCP Tools

9 tools — focused, well-described, no bloat:

| Tool | Purpose |
|------|---------|
| `memrecall_remember` | Save a memory (auto-embeds if provider available) |
| `memrecall_recall` | Search memories + auto-append KG triples |
| `memrecall_update` | Update existing memory content |
| `memrecall_forget` | Mark memory as expired (soft delete) |
| `memrecall_status` | Statistics overview |
| `memrecall_kg_add` | Save a structured fact triple |
| `memrecall_kg_query` | Query entity relationships |
| `memrecall_kg_invalidate` | Expire a fact |
| `memrecall_mine` | Mine conversation history |

## CLI

```bash
# Start MCP server
memrecall serve

# Search
memrecall search "inventory"                 # Hybrid FTS5 + vector
memrecall search "VAT" --project owt         # Filter by project

# Memory management
memrecall status                             # Stats + embedding coverage
memrecall list --project owt                 # Recent memories
memrecall get <id>                           # View specific memory

# Embeddings
memrecall embed                              # Backfill all memories
memrecall embed --status                     # Coverage stats
memrecall embed --force                      # Re-embed (after model switch)

# Conversation mining
memrecall mine ~/.claude --project owt       # Mine Claude Code history
memrecall mine ~/.claude --extract           # Smart extraction mode
memrecall mine ~/.claude --dry-run           # Preview without saving

# Knowledge graph
memrecall kg query OWT                       # Facts about entity
memrecall kg timeline OWT                    # Chronological history
memrecall kg list                            # All active triples

# Maintenance
memrecall backup                             # Backup database
memrecall export --project owt -o backup.json
memrecall import backup.json
memrecall gc --before 2025-01                # Clean expired memories
```

## Architecture

```
~/.memrecall/memrecall.db          Single SQLite file (WAL mode)
├── memories table                 Content + FTS5 index + embedding BLOB
├── memories_fts                   FTS5 virtual table (keyword search)
└── triples table                  Knowledge graph (subject → predicate → object)
```

```
src/
├── db.ts                          SQLite + migrations (user_version pragma)
├── types.ts                       TypeScript definitions
├── memories.ts                    CRUD + FTS5 sync + embed on save
├── search.ts                      Hybrid search (FTS5 + vector + RRF) + enhanced recall
├── embed.ts                       Embedding providers (Ollama → transformers.js → null)
├── kg.ts                          Knowledge graph CRUD
├── server.ts                      MCP server (9 tools + 1 resource)
├── index.ts                       CLI (commander)
└── mining/
    ├── types.ts                   Parser + extractor interfaces
    ├── claude-code-parser.ts      Claude Code JSONL parser
    ├── extractor.ts               Keyword pattern extraction
    └── index.ts                   Mine orchestrator + dedup
```

4 runtime dependencies: `better-sqlite3`, `@modelcontextprotocol/sdk`, `commander`, `nanoid`, `zod`.

## License

MIT
