# memrecall

Long-term memory for AI assistants. One command to install, works forever.

**v2** adds semantic search (vector embeddings), knowledge graph, and conversation mining -- all zero-config.

## Features

- **Persistent memory** -- AI remembers decisions, feedback, bugs, and context across conversations
- **Hybrid search** -- FTS5 keyword search + vector embeddings merged via Reciprocal Rank Fusion
- **Knowledge graph** -- structured facts as temporal triples (subject, predicate, object)
- **Conversation mining** -- retroactively extract memories from Claude Code history
- **Zero config** -- single SQLite file at `~/.memrecall/memrecall.db`, auto-detects embedding providers
- **9 MCP tools** -- works with Claude Code, Cursor, Windsurf, and any MCP client

## Install

```bash
npm install -g memrecall
```

### Optional: Enhanced Semantic Search

Embeddings work out of the box if either of these is available:

1. **Ollama** (recommended) -- run `ollama pull all-minilm` and have Ollama running on `localhost:11434`
2. **@huggingface/transformers** -- install alongside: `npm install -g @huggingface/transformers`

If neither is available, memrecall falls back to FTS5 keyword search (v1 behavior). No data loss, no errors.

## Setup

### Claude Code

```bash
claude mcp add memrecall -e MEMRECALL_PROJECT=myproject -- memrecall serve
```

### Cursor / Windsurf

Add to your MCP settings:

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

`MEMRECALL_PROJECT` is optional. Sets the default project for search.

## How It Works

1. AI reads tool descriptions and calls `memrecall_recall` at conversation start
2. During conversation, AI auto-saves important memories (decisions, feedback, bugs)
3. Next conversation, AI recalls relevant memories automatically
4. Memories stored in `~/.memrecall/memrecall.db` (single SQLite file)

### Semantic Search

When you save a memory, memrecall automatically generates a vector embedding (if a provider is available). On search, both FTS5 keyword matching and vector cosine similarity run, and results are merged via Reciprocal Rank Fusion (RRF):

```
"Chose PostgreSQL for the persistence layer"
  -> FTS5: matches "PostgreSQL", "persistence"
  -> Vector: also matches queries like "database decision" (semantic similarity)
  -> RRF merge: best of both worlds
```

### Knowledge Graph

The AI can save structured facts as triples with temporal tracking:

```
memrecall_kg_add({ subject: "OWT", predicate: "uses", object: "Prisma 7" })
memrecall_kg_query({ entity: "OWT" })
  -> OWT -> uses -> Prisma 7 (since 2026-01-01)
  -> OWT -> uses -> Nuxt 4 (since 2025-06-01)
```

When you search with `memrecall_recall`, relevant knowledge graph triples are automatically appended to the results.

### Conversation Mining

Extract memories from past Claude Code conversations:

```bash
memrecall mine ~/.claude --project myproject            # raw mode: 1 memory per conversation
memrecall mine ~/.claude --project myproject --extract   # smart mode: extract decisions/feedback/bugs
memrecall mine ~/.claude --dry-run                       # preview without saving
```

Smart extraction uses keyword patterns (English + Vietnamese) to classify:
- **Decisions**: "decided to", "chose", "going with", "let's use"
- **Feedback**: "don't", "never", "always prefer"
- **Bugs**: "root cause", "failed because", "the issue was"

Duplicate detection (>70% word overlap) prevents re-importing existing memories.

## Memory Types

| Type | Description | Decay |
|------|-------------|-------|
| decision | Architecture choices, tech decisions | Slow (2yr half-life) |
| feedback | User preferences, corrections | Slow (2yr half-life) |
| bug | Root causes of complex bugs | Fast (6mo half-life) |
| reference | Pointers to external resources | Medium (1yr half-life) |
| context | General project information | Fast (6mo half-life) |

## MCP Tools

| Tool | Description |
|------|-------------|
| `memrecall_remember` | Save a memory (auto-embeds if provider available) |
| `memrecall_recall` | Hybrid search memories + knowledge graph triples |
| `memrecall_update` | Update an existing memory's content |
| `memrecall_forget` | Mark a memory as expired |
| `memrecall_status` | Memory statistics overview |
| `memrecall_kg_add` | Save a knowledge graph triple |
| `memrecall_kg_query` | Query facts about an entity |
| `memrecall_kg_invalidate` | Mark a triple as no longer valid |
| `memrecall_mine` | Mine conversation history for memories |

## CLI

```bash
# MCP server
memrecall serve                              # Start MCP server (stdio transport)

# Search
memrecall search "inventory"                 # Hybrid search (FTS5 + vector if available)
memrecall search "VAT" --project owt         # Search specific project
memrecall search "VAT" --projects owt,api    # Search multiple projects

# Status
memrecall status                             # Overview stats + embedding coverage
memrecall status --project owt               # Project stats

# List / View
memrecall list --project owt                 # List recent memories
memrecall get <id>                           # View specific memory

# Embeddings
memrecall embed                              # Backfill embeddings for all memories
memrecall embed --project owt                # Backfill specific project
memrecall embed --force                      # Re-embed all (when switching model)
memrecall embed --status                     # Show embedding coverage

# Conversation Mining
memrecall mine ~/.claude                     # Auto-detect format, mine all
memrecall mine ~/.claude --project owt       # Tag mined memories with project
memrecall mine ~/.claude --extract           # Smart extraction (decisions, feedback, bugs)
memrecall mine ~/.claude --dry-run           # Preview without saving

# Knowledge Graph
memrecall kg query OWT                       # All facts about an entity
memrecall kg timeline OWT                    # Chronological history
memrecall kg list --project owt              # All active triples

# Maintenance
memrecall backup                             # Backup database
memrecall export --project owt               # Export to JSON
memrecall import memories.json               # Import from JSON
memrecall gc --before 2025-01                # Clean up old expired memories
```

## License

MIT
