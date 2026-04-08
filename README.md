# memrecall

Long-term memory for AI assistants. One command to install, works forever.

## Install

```bash
npm install -g memrecall
```

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

1. AI reads tool descriptions → knows to call `memrecall_recall` at conversation start
2. During conversation, AI auto-saves important memories (decisions, feedback, bugs)
3. Next conversation, AI recalls relevant memories automatically
4. Memories stored in `~/.memrecall/memrecall.db` (single SQLite file)

## Memory Types

| Type | Description | Decay |
|------|-------------|-------|
| decision | Architecture choices, tech decisions | Slow (2yr half-life) |
| feedback | User preferences, corrections | Slow (2yr half-life) |
| bug | Root causes of complex bugs | Fast (6mo half-life) |
| reference | Pointers to external resources | Medium (1yr half-life) |
| context | General project information | Fast (6mo half-life) |

## CLI

```bash
memrecall serve                          # Start MCP server
memrecall search "inventory"             # Search memories
memrecall search "VAT" --project owt     # Search specific project
memrecall status                         # Overview stats
memrecall list --project owt             # List recent memories
memrecall get <id>                       # View specific memory
memrecall backup                         # Backup database
memrecall export --project owt           # Export to JSON
memrecall import memories.json           # Import from JSON
memrecall gc --before 2025-01            # Clean up old expired memories
```

## License

MIT
