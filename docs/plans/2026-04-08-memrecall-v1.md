# memrecall v1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an MCP server that gives AI assistants persistent long-term memory via SQLite + FTS5.

**Architecture:** Single npm package. SQLite DB at `~/.memrecall/memrecall.db`. MCP server exposes 5 tools + 1 optional resource. CLI for manual operations. Application-level FTS5 sync in transactions.

**Tech Stack:** TypeScript, @modelcontextprotocol/sdk, better-sqlite3, nanoid, commander, vitest

**Design Doc:** `docs/design.md` — read this first for full context on every decision.

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/types.ts`
- Create: `bin/memrecall.js`
- Create: `.gitignore`

**Step 1: Initialize project**

```bash
cd ~/Desktop/vt7/memrecall
git init
```

**Step 2: Create package.json**

```json
{
  "name": "memrecall",
  "version": "0.1.0",
  "description": "MCP server providing long-term memory for AI assistants",
  "type": "module",
  "bin": {
    "memrecall": "./bin/memrecall.js"
  },
  "main": "./dist/index.js",
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "tsc --noEmit"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "better-sqlite3": "^11.0.0",
    "commander": "^13.0.0",
    "nanoid": "^5.0.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^22.0.0",
    "typescript": "^5.9.0",
    "vitest": "^3.0.0"
  },
  "files": ["dist", "bin"],
  "license": "MIT"
}
```

**Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
```

**Step 4: Create vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 10000,
  },
})
```

**Step 5: Create src/types.ts**

```typescript
export type MemoryType = 'decision' | 'feedback' | 'bug' | 'context' | 'reference'

export interface Memory {
  id: string
  type: MemoryType
  content: string
  weight: number
  project: string | null
  tags: string[] | null
  validFrom: string
  validUntil: string | null
  accessCount: number
  lastAccessedAt: string | null
  createdAt: string
}

export interface CreateMemoryInput {
  type: MemoryType
  content: string
  project?: string
  tags?: string[]
}

export interface SearchInput {
  query?: string
  projects?: string[]
  type?: MemoryType
  limit?: number
}

export interface UpdateMemoryInput {
  id: string
  content: string
}

export interface MemoryStats {
  total: number
  active: number
  expired: number
  byType: Record<MemoryType, number>
  byProject: Record<string, number>
}

export const TYPE_WEIGHTS: Record<MemoryType, number> = {
  decision: 1.0,
  feedback: 0.9,
  bug: 0.7,
  reference: 0.6,
  context: 0.5,
}

export const TYPE_HALF_LIFE_DAYS: Record<MemoryType, number> = {
  decision: 730,
  feedback: 730,
  bug: 180,
  reference: 365,
  context: 180,
}

export const MEMORY_TYPES: MemoryType[] = ['decision', 'feedback', 'bug', 'context', 'reference']

export const MAX_CONTENT_LENGTH = 2000
```

**Step 6: Create bin/memrecall.js**

```javascript
#!/usr/bin/env node
import '../dist/index.js'
```

**Step 7: Create .gitignore**

```
node_modules/
dist/
*.db
*.db-wal
*.db-shm
.env
```

**Step 8: Install dependencies**

```bash
pnpm install
```

**Step 9: Verify TypeScript compiles**

```bash
pnpm build
```

Expected: Compiles with no errors (types.ts only).

**Step 10: Commit**

```bash
git add -A
git commit -m "chore: project scaffolding — package.json, tsconfig, types"
```

---

### Task 2: Database Layer

**Files:**
- Create: `src/db.ts`
- Create: `src/db.test.ts`

**Step 1: Write the failing test**

```typescript
// src/db.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabase, closeDatabase } from './db.js'
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import os from 'os'

const TEST_DB_DIR = path.join(os.tmpdir(), 'memrecall-test-' + Date.now())
const TEST_DB_PATH = path.join(TEST_DB_DIR, 'memrecall.db')

describe('database', () => {
  let db: Database.Database

  beforeEach(() => {
    fs.mkdirSync(TEST_DB_DIR, { recursive: true })
    db = createDatabase(TEST_DB_PATH)
  })

  afterEach(() => {
    closeDatabase(db)
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true })
  })

  it('creates memories table', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories'").get()
    expect(tables).toBeTruthy()
  })

  it('creates memories_fts virtual table', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'").get()
    expect(tables).toBeTruthy()
  })

  it('enables WAL mode', () => {
    const mode = db.pragma('journal_mode', { simple: true })
    expect(mode).toBe('wal')
  })

  it('sets busy timeout', () => {
    const timeout = db.pragma('busy_timeout', { simple: true })
    expect(timeout).toBe(5000)
  })

  it('sets user_version to 1', () => {
    const version = db.pragma('user_version', { simple: true })
    expect(version).toBe(1)
  })

  it('creates indexes', () => {
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'").all()
    const names = indexes.map((i: any) => i.name)
    expect(names).toContain('idx_project_valid')
    expect(names).toContain('idx_created_at')
  })

  it('skips migration if already at current version', () => {
    // Creating again should not throw
    const db2 = createDatabase(TEST_DB_PATH)
    const version = db2.pragma('user_version', { simple: true })
    expect(version).toBe(1)
    closeDatabase(db2)
  })
})
```

**Step 2: Run test to verify it fails**

```bash
pnpm test src/db.test.ts
```

Expected: FAIL — `createDatabase` not found.

**Step 3: Write implementation**

```typescript
// src/db.ts
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import os from 'os'

const DEFAULT_DB_DIR = path.join(os.homedir(), '.memrecall')
const DEFAULT_DB_PATH = path.join(DEFAULT_DB_DIR, 'memrecall.db')

let verbose = false

export function setVerbose(v: boolean) {
  verbose = v
}

function log(...args: unknown[]) {
  if (verbose) console.error('[memrecall]', ...args)
}

export function getDefaultDbPath(): string {
  return DEFAULT_DB_PATH
}

export function createDatabase(dbPath: string = DEFAULT_DB_PATH): Database.Database {
  const dir = path.dirname(dbPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { mode: 0o700, recursive: true })
    log('Created directory:', dir)
  }

  const db = new Database(dbPath)

  // SQLite configuration
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  db.pragma('foreign_keys = ON')

  // Run migrations
  migrate(db)

  log('Database ready:', dbPath)
  return db
}

function migrate(db: Database.Database) {
  const version = db.pragma('user_version', { simple: true }) as number

  if (version < 1) {
    log('Running migration v0 → v1')
    db.exec(`
      CREATE TABLE memories (
        id               TEXT PRIMARY KEY,
        type             TEXT NOT NULL,
        content          TEXT NOT NULL,
        weight           REAL NOT NULL,
        project          TEXT,
        tags             TEXT,
        valid_from       TEXT NOT NULL,
        valid_until      TEXT,
        access_count     INTEGER NOT NULL DEFAULT 0,
        last_accessed_at TEXT,
        created_at       TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE memories_fts USING fts5(
        content,
        tags,
        content='memories',
        content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2'
      );

      CREATE INDEX idx_project_valid ON memories(project, valid_until) WHERE valid_until IS NULL;
      CREATE INDEX idx_created_at ON memories(created_at);
    `)
    db.pragma('user_version = 1')
  }
}

export function closeDatabase(db: Database.Database) {
  db.close()
}
```

**Step 4: Run test to verify it passes**

```bash
pnpm test src/db.test.ts
```

Expected: All 7 tests PASS.

**Step 5: Commit**

```bash
git add src/db.ts src/db.test.ts
git commit -m "feat: database layer — SQLite + WAL + FTS5 + migration"
```

---

### Task 3: Memory CRUD with FTS5 Sync

**Files:**
- Create: `src/memories.ts`
- Create: `src/memories.test.ts`

**Step 1: Write the failing tests**

```typescript
// src/memories.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabase, closeDatabase } from './db.js'
import { createMemory, getMemory, updateMemory, expireMemory, getStats } from './memories.js'
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import os from 'os'

const TEST_DB_DIR = path.join(os.tmpdir(), 'memrecall-mem-test-' + Date.now())
const TEST_DB_PATH = path.join(TEST_DB_DIR, 'memrecall.db')

describe('memories', () => {
  let db: Database.Database

  beforeEach(() => {
    fs.mkdirSync(TEST_DB_DIR, { recursive: true })
    db = createDatabase(TEST_DB_PATH)
  })

  afterEach(() => {
    closeDatabase(db)
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true })
  })

  describe('createMemory', () => {
    it('creates a memory with auto-assigned weight', () => {
      const mem = createMemory(db, { type: 'decision', content: 'Use SQLite for storage' })
      expect(mem.id).toBeTruthy()
      expect(mem.type).toBe('decision')
      expect(mem.weight).toBe(1.0)
      expect(mem.validUntil).toBeNull()
    })

    it('normalizes project name', () => {
      const mem = createMemory(db, { type: 'context', content: 'Test', project: 'OWT Platform' })
      expect(mem.project).toBe('owt-platform')
    })

    it('rejects empty content', () => {
      expect(() => createMemory(db, { type: 'decision', content: '   ' })).toThrow('Content cannot be empty')
    })

    it('rejects content over 2000 chars', () => {
      expect(() => createMemory(db, { type: 'decision', content: 'x'.repeat(2001) })).toThrow('Content exceeds 2000 character limit')
    })

    it('syncs to FTS5 index', () => {
      createMemory(db, { type: 'decision', content: 'Use SQLite for persistent storage', tags: ['architecture'] })
      const ftsResult = db.prepare("SELECT * FROM memories_fts WHERE memories_fts MATCH 'SQLite'").all()
      expect(ftsResult.length).toBe(1)
    })

    it('stores tags as JSON in memories table', () => {
      const mem = createMemory(db, { type: 'bug', content: 'Test', tags: ['prisma', 'migration'] })
      const row = db.prepare('SELECT tags FROM memories WHERE id = ?').get(mem.id) as any
      expect(JSON.parse(row.tags)).toEqual(['prisma', 'migration'])
    })
  })

  describe('getMemory', () => {
    it('returns memory by id', () => {
      const created = createMemory(db, { type: 'feedback', content: 'Never use disabled buttons' })
      const found = getMemory(db, created.id)
      expect(found).toBeTruthy()
      expect(found!.content).toBe('Never use disabled buttons')
    })

    it('returns null for non-existent id', () => {
      expect(getMemory(db, 'nonexistent')).toBeNull()
    })
  })

  describe('updateMemory', () => {
    it('updates content and syncs FTS5', () => {
      const mem = createMemory(db, { type: 'decision', content: 'Use PostgreSQL' })
      updateMemory(db, { id: mem.id, content: 'Use SQLite instead of PostgreSQL' })

      const updated = getMemory(db, mem.id)
      expect(updated!.content).toBe('Use SQLite instead of PostgreSQL')

      // Old content should not match
      const oldMatch = db.prepare("SELECT * FROM memories_fts WHERE memories_fts MATCH 'PostgreSQL' AND NOT memories_fts MATCH 'SQLite'").all()
      expect(oldMatch.length).toBe(0)

      // New content should match
      const newMatch = db.prepare("SELECT * FROM memories_fts WHERE memories_fts MATCH 'SQLite'").all()
      expect(newMatch.length).toBe(1)
    })

    it('throws on non-existent id', () => {
      expect(() => updateMemory(db, { id: 'nonexistent', content: 'test' })).toThrow()
    })
  })

  describe('expireMemory', () => {
    it('sets valid_until and removes from FTS5', () => {
      const mem = createMemory(db, { type: 'decision', content: 'Use Redis for caching' })
      expireMemory(db, mem.id)

      const expired = getMemory(db, mem.id)
      expect(expired!.validUntil).toBeTruthy()

      // Should not appear in FTS5 search
      const ftsResult = db.prepare("SELECT * FROM memories_fts WHERE memories_fts MATCH 'Redis'").all()
      expect(ftsResult.length).toBe(0)
    })
  })

  describe('getStats', () => {
    it('returns correct counts', () => {
      createMemory(db, { type: 'decision', content: 'Test 1', project: 'owt' })
      createMemory(db, { type: 'feedback', content: 'Test 2', project: 'owt' })
      createMemory(db, { type: 'bug', content: 'Test 3' })
      const mem4 = createMemory(db, { type: 'context', content: 'Test 4', project: 'owt' })
      expireMemory(db, mem4.id)

      const stats = getStats(db)
      expect(stats.total).toBe(4)
      expect(stats.active).toBe(3)
      expect(stats.expired).toBe(1)
      expect(stats.byType.decision).toBe(1)
      expect(stats.byType.feedback).toBe(1)
      expect(stats.byProject.owt).toBe(3)
    })
  })
})
```

**Step 2: Run test to verify it fails**

```bash
pnpm test src/memories.test.ts
```

Expected: FAIL — imports not found.

**Step 3: Write implementation**

```typescript
// src/memories.ts
import Database from 'better-sqlite3'
import { nanoid } from 'nanoid'
import type { Memory, CreateMemoryInput, UpdateMemoryInput, MemoryStats, MemoryType } from './types.js'
import { TYPE_WEIGHTS, MAX_CONTENT_LENGTH, MEMORY_TYPES } from './types.js'

function normalizeProject(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
}

function validateContent(content: string): void {
  if (content.trim().length === 0) throw new Error('Content cannot be empty')
  if (content.length > MAX_CONTENT_LENGTH) throw new Error(`Content exceeds ${MAX_CONTENT_LENGTH} character limit`)
}

function tagsToFts(tags: string[] | null | undefined): string {
  return (tags || []).join(' ')
}

export function rowToMemory(row: any): Memory {
  return {
    id: row.id,
    type: row.type,
    content: row.content,
    weight: row.weight,
    project: row.project,
    tags: row.tags ? JSON.parse(row.tags) : null,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    accessCount: row.access_count,
    lastAccessedAt: row.last_accessed_at,
    createdAt: row.created_at,
  }
}

export function createMemory(db: Database.Database, input: CreateMemoryInput): Memory {
  validateContent(input.content)

  const id = nanoid(12)
  const now = new Date().toISOString()
  const project = input.project ? normalizeProject(input.project) : null
  const weight = TYPE_WEIGHTS[input.type]
  const tags = input.tags && input.tags.length > 0 ? input.tags : null

  db.transaction(() => {
    db.prepare(`
      INSERT INTO memories (id, type, content, weight, project, tags, valid_from, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.type, input.content, weight, project, tags ? JSON.stringify(tags) : null, now, now)

    db.prepare(`
      INSERT INTO memories_fts (rowid, content, tags)
      VALUES (last_insert_rowid(), ?, ?)
    `).run(input.content, tagsToFts(tags))
  })()

  return getMemory(db, id)!
}

export function getMemory(db: Database.Database, id: string): Memory | null {
  const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id)
  return row ? rowToMemory(row) : null
}

export function updateMemory(db: Database.Database, input: UpdateMemoryInput): Memory {
  validateContent(input.content)

  const old = db.prepare('SELECT rowid, * FROM memories WHERE id = ?').get(input.id) as any
  if (!old) throw new Error(`Memory not found: ${input.id}`)

  const oldTags = old.tags ? JSON.parse(old.tags) : null

  db.transaction(() => {
    db.prepare('UPDATE memories SET content = ? WHERE id = ?').run(input.content, input.id)

    // Sync FTS5: delete old entry, insert new
    db.prepare("INSERT INTO memories_fts (memories_fts, rowid, content, tags) VALUES ('delete', ?, ?, ?)")
      .run(old.rowid, old.content, tagsToFts(oldTags))
    db.prepare('INSERT INTO memories_fts (rowid, content, tags) VALUES (?, ?, ?)')
      .run(old.rowid, input.content, tagsToFts(oldTags))
  })()

  return getMemory(db, input.id)!
}

export function expireMemory(db: Database.Database, id: string, reason?: string): void {
  const old = db.prepare('SELECT rowid, * FROM memories WHERE id = ?').get(id) as any
  if (!old) throw new Error(`Memory not found: ${id}`)

  const oldTags = old.tags ? JSON.parse(old.tags) : null

  db.transaction(() => {
    db.prepare('UPDATE memories SET valid_until = ? WHERE id = ?').run(new Date().toISOString(), id)

    // Remove from FTS5 (expired memories should not appear in search)
    db.prepare("INSERT INTO memories_fts (memories_fts, rowid, content, tags) VALUES ('delete', ?, ?, ?)")
      .run(old.rowid, old.content, tagsToFts(oldTags))
  })()
}

export function getStats(db: Database.Database, project?: string): MemoryStats {
  const where = project ? 'WHERE project = ?' : ''
  const params = project ? [project] : []

  const total = (db.prepare(`SELECT COUNT(*) as count FROM memories ${where}`).get(...params) as any).count
  const active = (db.prepare(`SELECT COUNT(*) as count FROM memories ${where ? where + ' AND' : 'WHERE'} valid_until IS NULL`).get(...params) as any).count
  const expired = total - active

  const byType: Record<string, number> = {}
  for (const type of MEMORY_TYPES) {
    const count = (db.prepare(`SELECT COUNT(*) as count FROM memories ${where ? where + ' AND' : 'WHERE'} type = ?`).get(...[...params, type]) as any).count
    byType[type] = count
  }

  const byProject: Record<string, number> = {}
  const projectRows = db.prepare(`SELECT project, COUNT(*) as count FROM memories ${where} GROUP BY project`).all(...params) as any[]
  for (const row of projectRows) {
    byProject[row.project || '(global)'] = row.count
  }

  return { total, active, expired, byType: byType as Record<MemoryType, number>, byProject }
}
```

**Step 4: Run test to verify it passes**

```bash
pnpm test src/memories.test.ts
```

Expected: All tests PASS.

**Step 5: Commit**

```bash
git add src/memories.ts src/memories.test.ts
git commit -m "feat: memory CRUD with FTS5 sync in transactions"
```

---

### Task 4: Search + Ranking

**Files:**
- Create: `src/search.ts`
- Create: `src/search.test.ts`

**Step 1: Write the failing tests**

```typescript
// src/search.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabase, closeDatabase } from './db.js'
import { createMemory } from './memories.js'
import { searchMemories, getTopMemories } from './search.js'
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import os from 'os'

const TEST_DB_DIR = path.join(os.tmpdir(), 'memrecall-search-test-' + Date.now())
const TEST_DB_PATH = path.join(TEST_DB_DIR, 'memrecall.db')

describe('search', () => {
  let db: Database.Database

  beforeEach(() => {
    fs.mkdirSync(TEST_DB_DIR, { recursive: true })
    db = createDatabase(TEST_DB_PATH)

    // Seed test data
    createMemory(db, { type: 'decision', content: 'Use per-variant inventory tracking for flexibility', project: 'owt', tags: ['inventory', 'architecture'] })
    createMemory(db, { type: 'feedback', content: 'Never use disabled buttons, always allow click and show error', project: 'owt' })
    createMemory(db, { type: 'bug', content: 'Prisma generate must run after every schema change', project: 'owt', tags: ['prisma'] })
    createMemory(db, { type: 'decision', content: 'Use SQLite for recall storage instead of PostgreSQL', project: 'memrecall', tags: ['architecture'] })
    createMemory(db, { type: 'feedback', content: 'User prefers terse responses without trailing summaries' })  // global
  })

  afterEach(() => {
    closeDatabase(db)
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true })
  })

  describe('searchMemories (with query)', () => {
    it('finds memories by keyword', () => {
      const results = searchMemories(db, { query: 'inventory' })
      expect(results.length).toBeGreaterThan(0)
      expect(results[0].content).toContain('inventory')
    })

    it('filters by project + includes globals', () => {
      const results = searchMemories(db, { query: 'buttons OR terse', projects: ['owt'] })
      // Should find 'disabled buttons' (owt) and 'terse responses' (global)
      expect(results.length).toBe(2)
    })

    it('filters by type', () => {
      const results = searchMemories(db, { query: 'inventory OR SQLite', type: 'decision' })
      expect(results.every(r => r.type === 'decision')).toBe(true)
    })

    it('respects limit', () => {
      const results = searchMemories(db, { query: 'use OR never', limit: 2 })
      expect(results.length).toBe(2)
    })

    it('finds by tag', () => {
      const results = searchMemories(db, { query: 'prisma' })
      expect(results.length).toBeGreaterThan(0)
    })

    it('returns empty for no match', () => {
      const results = searchMemories(db, { query: 'nonexistent_xyz_keyword' })
      expect(results.length).toBe(0)
    })
  })

  describe('getTopMemories (without query)', () => {
    it('returns top memories by score for project', () => {
      const results = getTopMemories(db, 'owt', 10)
      expect(results.length).toBeGreaterThan(0)
      // Decisions should rank higher than bugs (weight 1.0 vs 0.7)
      const decisionIdx = results.findIndex(r => r.type === 'decision')
      const bugIdx = results.findIndex(r => r.type === 'bug')
      if (decisionIdx !== -1 && bugIdx !== -1) {
        expect(decisionIdx).toBeLessThan(bugIdx)
      }
    })

    it('includes global memories', () => {
      const results = getTopMemories(db, 'owt', 10)
      const global = results.find(r => r.project === null)
      expect(global).toBeTruthy()
    })

    it('returns all projects when project is null', () => {
      const results = getTopMemories(db, null, 10)
      expect(results.length).toBe(5)
    })
  })

  describe('access tracking', () => {
    it('increments access_count on search', () => {
      const before = searchMemories(db, { query: 'inventory' })
      expect(before[0].accessCount).toBe(1) // incremented by this search

      const after = searchMemories(db, { query: 'inventory' })
      expect(after[0].accessCount).toBe(2) // incremented again
    })
  })
})
```

**Step 2: Run test to verify it fails**

```bash
pnpm test src/search.test.ts
```

Expected: FAIL — imports not found.

**Step 3: Write implementation**

```typescript
// src/search.ts
import Database from 'better-sqlite3'
import type { Memory, SearchInput, MemoryType } from './types.js'
import { TYPE_HALF_LIFE_DAYS } from './types.js'
import { rowToMemory } from './memories.js'

function sanitizeFtsQuery(query: string): string {
  // Escape FTS5 special characters, wrap each term in quotes for safety
  // Uses implicit AND (FTS5 default) — "VAT pricing" matches both terms
  return query
    .replace(/['"]/g, '')
    .split(/\s+/)
    .filter(t => t.length > 0)
    .map(t => `"${t}"`)
    .join(' ')
}

function updateAccessCounts(db: Database.Database, ids: string[]): void {
  if (ids.length === 0) return
  const now = new Date().toISOString()
  const stmt = db.prepare('UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?')
  const batchUpdate = db.transaction(() => {
    for (const id of ids) {
      stmt.run(now, id)
    }
  })
  batchUpdate()
}

export function searchMemories(db: Database.Database, input: SearchInput): Memory[] {
  const { query, projects, type, limit = 10 } = input

  if (!query || query.trim().length === 0) {
    return getTopMemories(db, projects?.[0] ?? null, limit)
  }

  const sanitized = sanitizeFtsQuery(query)
  if (!sanitized) return []

  let sql = `
    SELECT m.*, fts.rank AS fts_rank
    FROM memories_fts fts
    JOIN memories m ON m.rowid = fts.rowid
    WHERE fts MATCH ?
      AND m.valid_until IS NULL
  `
  const params: any[] = [sanitized]

  // Project filter: include specified projects + globals
  if (projects && projects.length > 0) {
    const placeholders = projects.map(() => '?').join(', ')
    sql += ` AND (m.project IN (${placeholders}) OR m.project IS NULL)`
    params.push(...projects)
  }

  // Type filter
  if (type) {
    sql += ' AND m.type = ?'
    params.push(type)
  }

  sql += `
    ORDER BY
      (fts.rank * -1)
      * m.weight
      * (1.0 / (1 + (julianday('now') - julianday(m.created_at)) /
          CASE m.type
            WHEN 'decision' THEN ${TYPE_HALF_LIFE_DAYS.decision}
            WHEN 'feedback' THEN ${TYPE_HALF_LIFE_DAYS.feedback}
            WHEN 'bug' THEN ${TYPE_HALF_LIFE_DAYS.bug}
            WHEN 'reference' THEN ${TYPE_HALF_LIFE_DAYS.reference}
            ELSE ${TYPE_HALF_LIFE_DAYS.context}
          END))
      * (1.0 + min(m.access_count, 10) * 0.1)
      DESC
    LIMIT ?
  `
  params.push(limit)

  let results: Memory[]
  try {
    results = db.prepare(sql).all(...params).map(rowToMemory)
  } catch {
    // FTS5 query syntax error — return empty instead of crashing
    results = []
  }

  // Update access counts
  updateAccessCounts(db, results.map(r => r.id))

  return results
}

export function getTopMemories(db: Database.Database, project: string | null, limit: number): Memory[] {
  let sql = `
    SELECT *,
      weight
      * (1.0 / (1 + (julianday('now') - julianday(created_at)) /
          CASE type
            WHEN 'decision' THEN ${TYPE_HALF_LIFE_DAYS.decision}
            WHEN 'feedback' THEN ${TYPE_HALF_LIFE_DAYS.feedback}
            WHEN 'bug' THEN ${TYPE_HALF_LIFE_DAYS.bug}
            WHEN 'reference' THEN ${TYPE_HALF_LIFE_DAYS.reference}
            ELSE ${TYPE_HALF_LIFE_DAYS.context}
          END))
      * (1.0 + min(access_count, 10) * 0.1)
      AS score
    FROM memories
    WHERE valid_until IS NULL
  `
  const params: any[] = []

  if (project) {
    sql += ' AND (project = ? OR project IS NULL)'
    params.push(project)
  }

  sql += ' ORDER BY score DESC LIMIT ?'
  params.push(limit)

  const results = db.prepare(sql).all(...params).map(rowToMemory)

  // Update access counts
  updateAccessCounts(db, results.map(r => r.id))

  return results
}
```

**Step 4: Run test to verify it passes**

```bash
pnpm test src/search.test.ts
```

Expected: All tests PASS.

**Step 5: Commit**

```bash
git add src/search.ts src/search.test.ts
git commit -m "feat: FTS5 search + combined ranking with type-based half-life"
```

---

### Task 5: MCP Server

**Files:**
- Create: `src/server.ts`

This task has no unit tests — MCP server is integration/wiring code. Test manually after Task 7 (CLI).

**Step 1: Write implementation**

```typescript
// src/server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import Database from 'better-sqlite3'
import { createDatabase } from './db.js'
import { createMemory, getMemory, updateMemory, expireMemory, getStats } from './memories.js'
import { searchMemories, getTopMemories } from './search.js'
import { MEMORY_TYPES } from './types.js'
import type { MemoryType } from './types.js'

export async function startServer() {
  const db = createDatabase()
  const defaultProject = process.env.MEMRECALL_PROJECT || null

  const server = new McpServer({
    name: 'memrecall',
    version: '0.1.0',
  })

  // Tool: memrecall_remember
  server.tool(
    'memrecall_remember',
    `Save important information from this conversation as a long-term memory.

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
    {
      type: z.enum(['decision', 'feedback', 'bug', 'context', 'reference']).describe('Memory type'),
      content: z.string().describe('The memory content. Be specific and include reasoning.'),
      project: z.string().optional().describe('Project identifier (lowercase slug). Omit for global memories.'),
      tags: z.array(z.string()).optional().describe('Optional categorization tags.'),
    },
    async (params) => {
      try {
        const memory = createMemory(db, {
          type: params.type as MemoryType,
          content: params.content,
          project: params.project || (defaultProject ?? undefined),
          tags: params.tags,
        })
        return { content: [{ type: 'text', text: JSON.stringify({ saved: true, id: memory.id, type: memory.type, project: memory.project }) }] }
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Unknown error'
        return { content: [{ type: 'text', text: JSON.stringify({ error: true, message }) }], isError: true }
      }
    }
  )

  // Tool: memrecall_recall
  server.tool(
    'memrecall_recall',
    `Search long-term memories from previous conversations.

IMPORTANT: Call this tool at the START of every new conversation with no query to load your long-term memory. This is essential — without it, you have no memory of previous conversations.

ALSO CALL WHEN:
- Needing context about a topic being discussed
- User asks "what did we decide about X"
- Before making a decision (check if prior decision exists)
- User references previous work or conversations`,
    {
      query: z.string().optional().describe('FTS search query. Omit to get top memories by score.'),
      projects: z.array(z.string()).optional().describe('Filter by projects. Omit to use default project from MEMRECALL_PROJECT env.'),
      type: z.enum(['decision', 'feedback', 'bug', 'context', 'reference']).optional().describe('Filter by memory type.'),
      limit: z.number().optional().default(10).describe('Max results to return.'),
    },
    async (params) => {
      try {
        const projects = params.projects || (defaultProject ? [defaultProject] : undefined)
        const results = params.query
          ? searchMemories(db, { query: params.query, projects, type: params.type as MemoryType | undefined, limit: params.limit })
          : getTopMemories(db, projects?.[0] ?? null, params.limit ?? 15)

        const formatted = results.map(m =>
          `[${m.type}]${m.project ? ` (${m.project})` : ''} ${m.content} {id:${m.id}}`
        ).join('\n')

        return { content: [{ type: 'text', text: formatted || 'No memories found.' }] }
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Unknown error'
        return { content: [{ type: 'text', text: JSON.stringify({ error: true, message }) }], isError: true }
      }
    }
  )

  // Tool: memrecall_update
  server.tool(
    'memrecall_update',
    `Update an existing memory's content. Use when information needs correction or additional context, but the memory is still about the same topic.

For replaced decisions (e.g., "we used to do X, now doing Y"):
use memrecall_forget on the old memory, then memrecall_remember for the new one.`,
    {
      id: z.string().describe('Memory ID to update.'),
      content: z.string().describe('Updated content.'),
    },
    async (params) => {
      try {
        const memory = updateMemory(db, { id: params.id, content: params.content })
        return { content: [{ type: 'text', text: JSON.stringify({ updated: true, id: memory.id }) }] }
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Unknown error'
        return { content: [{ type: 'text', text: JSON.stringify({ error: true, message }) }], isError: true }
      }
    }
  )

  // Tool: memrecall_forget
  server.tool(
    'memrecall_forget',
    `Mark a memory as expired. Does not delete — sets valid_until timestamp. Expired memories no longer appear in search results.

CALL WHEN:
- User says "forget that", "that's no longer true"
- A decision has been reverted
- Information is confirmed outdated`,
    {
      id: z.string().describe('Memory ID to expire.'),
      reason: z.string().optional().describe('Why this memory is no longer valid.'),
    },
    async (params) => {
      try {
        expireMemory(db, params.id, params.reason)
        return { content: [{ type: 'text', text: JSON.stringify({ forgotten: true, id: params.id }) }] }
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Unknown error'
        return { content: [{ type: 'text', text: JSON.stringify({ error: true, message }) }], isError: true }
      }
    }
  )

  // Tool: memrecall_status
  server.tool(
    'memrecall_status',
    'Get overview of stored memories: total count, breakdown by project and type.',
    {
      project: z.string().optional().describe('Filter stats by project. Omit for all.'),
    },
    async (params) => {
      try {
        const stats = getStats(db, params.project)
        return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] }
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Unknown error'
        return { content: [{ type: 'text', text: JSON.stringify({ error: true, message }) }], isError: true }
      }
    }
  )

  // Resource: memrecall://context (optional, for clients that support @-references)
  server.resource(
    'memrecall://context',
    'Top memories for the current project — decisions, feedback, and critical context',
    async () => {
      const memories = getTopMemories(db, defaultProject, 15)
      const formatted = memories.map(m =>
        `[${m.type}]${m.project ? ` (${m.project})` : ''} ${m.content}`
      ).join('\n')

      return {
        contents: [{
          uri: 'memrecall://context',
          mimeType: 'text/plain',
          text: formatted || 'No memories yet.',
        }]
      }
    }
  )

  // Connect via stdio
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
```

**Step 2: Verify TypeScript compiles**

```bash
pnpm build
```

Expected: No errors. Note: `zod` is a peer dependency of `@modelcontextprotocol/sdk` — if missing, install it:

```bash
pnpm add zod
```

**Step 3: Commit**

```bash
git add src/server.ts
git commit -m "feat: MCP server — 5 tools + context resource"
```

---

### Task 6: CLI

**Files:**
- Create: `src/index.ts`

**Step 1: Write implementation**

```typescript
// src/index.ts
import { Command } from 'commander'
import { createDatabase, closeDatabase, getDefaultDbPath, setVerbose } from './db.js'
import { createMemory, getMemory, getStats } from './memories.js'
import { searchMemories, getTopMemories } from './search.js'
import { startServer } from './server.js'
import fs from 'fs'
import path from 'path'

const program = new Command()

program
  .name('memrecall')
  .description('Long-term memory for AI assistants')
  .version('0.1.0')
  .option('--verbose', 'Enable verbose logging')

// memrecall serve
program
  .command('serve')
  .description('Start MCP server (stdio transport)')
  .action(async () => {
    if (program.opts().verbose) setVerbose(true)
    await startServer()
  })

// memrecall search <query>
program
  .command('search <query>')
  .description('Search memories')
  .option('-p, --project <project>', 'Filter by project')
  .option('--projects <projects>', 'Filter by multiple projects (comma-separated)')
  .option('-t, --type <type>', 'Filter by type')
  .option('-l, --limit <limit>', 'Max results', '10')
  .action((query, opts) => {
    if (program.opts().verbose) setVerbose(true)
    const db = createDatabase()
    try {
      const projects = opts.projects ? opts.projects.split(',') : opts.project ? [opts.project] : undefined
      const results = searchMemories(db, { query, projects, type: opts.type, limit: parseInt(opts.limit) })

      if (results.length === 0) {
        console.log('No memories found.')
        return
      }

      for (const m of results) {
        console.log(`[${m.type}]${m.project ? ` (${m.project})` : ''} ${m.content}`)
        console.log(`  id: ${m.id} | created: ${m.createdAt} | accessed: ${m.accessCount}x`)
        console.log()
      }
    } finally {
      closeDatabase(db)
    }
  })

// memrecall status
program
  .command('status')
  .description('Memory statistics')
  .option('-p, --project <project>', 'Filter by project')
  .action((opts) => {
    if (program.opts().verbose) setVerbose(true)
    const db = createDatabase()
    try {
      const stats = getStats(db, opts.project)
      console.log(`Total: ${stats.total} (${stats.active} active, ${stats.expired} expired)`)
      console.log('\nBy type:')
      for (const [type, count] of Object.entries(stats.byType)) {
        if (count > 0) console.log(`  ${type}: ${count}`)
      }
      console.log('\nBy project:')
      for (const [project, count] of Object.entries(stats.byProject)) {
        console.log(`  ${project}: ${count}`)
      }
    } finally {
      closeDatabase(db)
    }
  })

// memrecall list
program
  .command('list')
  .description('List recent memories')
  .option('-p, --project <project>', 'Filter by project')
  .option('-l, --limit <limit>', 'Max results', '20')
  .action((opts) => {
    if (program.opts().verbose) setVerbose(true)
    const db = createDatabase()
    try {
      const results = getTopMemories(db, opts.project || null, parseInt(opts.limit))
      for (const m of results) {
        console.log(`[${m.type}]${m.project ? ` (${m.project})` : ''} ${m.content}`)
        console.log(`  id: ${m.id} | created: ${m.createdAt}`)
        console.log()
      }
    } finally {
      closeDatabase(db)
    }
  })

// memrecall get <id>
program
  .command('get <id>')
  .description('View a specific memory')
  .action((id) => {
    if (program.opts().verbose) setVerbose(true)
    const db = createDatabase()
    try {
      const mem = getMemory(db, id)
      if (!mem) {
        console.error(`Memory not found: ${id}`)
        process.exit(1)
      }
      console.log(JSON.stringify(mem, null, 2))
    } finally {
      closeDatabase(db)
    }
  })

// memrecall export
program
  .command('export')
  .description('Export memories to JSON')
  .option('-p, --project <project>', 'Filter by project')
  .option('-o, --output <file>', 'Output file (default: stdout)')
  .action((opts) => {
    if (program.opts().verbose) setVerbose(true)
    const db = createDatabase()
    try {
      let sql = 'SELECT * FROM memories'
      const params: any[] = []
      if (opts.project) {
        sql += ' WHERE project = ?'
        params.push(opts.project)
      }
      sql += ' ORDER BY created_at DESC'
      const rows = db.prepare(sql).all(...params)
      const json = JSON.stringify(rows, null, 2)

      if (opts.output) {
        fs.writeFileSync(opts.output, json)
        console.error(`Exported ${rows.length} memories to ${opts.output}`)
      } else {
        console.log(json)
      }
    } finally {
      closeDatabase(db)
    }
  })

// memrecall import
program
  .command('import <file>')
  .description('Import memories from JSON file')
  .option('--dry-run', 'Show what would be imported without importing')
  .action((file, opts) => {
    if (program.opts().verbose) setVerbose(true)
    const db = createDatabase()
    try {
      const raw = fs.readFileSync(file, 'utf-8')
      const rows = JSON.parse(raw) as any[]

      if (opts.dryRun) {
        console.log(`Would import ${rows.length} memories`)
        return
      }

      let imported = 0
      let skipped = 0
      for (const row of rows) {
        const exists = db.prepare('SELECT id FROM memories WHERE id = ?').get(row.id)
        if (exists) { skipped++; continue }

        db.prepare(`
          INSERT INTO memories (id, type, content, weight, project, tags, valid_from, valid_until, access_count, last_accessed_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(row.id, row.type, row.content, row.weight, row.project, row.tags, row.valid_from, row.valid_until, row.access_count || 0, row.last_accessed_at, row.created_at)

        // Sync FTS5 (only for active memories)
        if (!row.valid_until) {
          const inserted = db.prepare('SELECT rowid FROM memories WHERE id = ?').get(row.id) as any
          const tagsText = row.tags ? JSON.parse(row.tags).join(' ') : ''
          db.prepare('INSERT INTO memories_fts (rowid, content, tags) VALUES (?, ?, ?)').run(inserted.rowid, row.content, tagsText)
        }

        imported++
      }
      console.log(`Imported ${imported} memories (${skipped} skipped — already exist)`)
    } finally {
      closeDatabase(db)
    }
  })

// memrecall backup
program
  .command('backup')
  .description('Create a backup of the database')
  .option('-o, --output <file>', 'Backup file path')
  .action((opts) => {
    const dbPath = getDefaultDbPath()
    if (!fs.existsSync(dbPath)) {
      console.error('No database found at', dbPath)
      process.exit(1)
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupPath = opts.output || path.join(path.dirname(dbPath), `memrecall-backup-${timestamp}.db`)

    // Use SQLite backup via file copy (WAL checkpoint first)
    const db = createDatabase()
    try {
      db.pragma('wal_checkpoint(TRUNCATE)')
      closeDatabase(db)
      fs.copyFileSync(dbPath, backupPath)
      console.log(`Backup created: ${backupPath}`)
    } catch {
      closeDatabase(db)
      console.error('Backup failed')
      process.exit(1)
    }
  })

// memrecall gc
program
  .command('gc')
  .description('Clean up expired memories')
  .option('--before <date>', 'Remove expired memories older than this date (ISO 8601)')
  .option('--dry-run', 'Show what would be removed without removing')
  .action((opts) => {
    if (program.opts().verbose) setVerbose(true)
    const db = createDatabase()
    try {
      let sql = 'SELECT COUNT(*) as count FROM memories WHERE valid_until IS NOT NULL'
      const params: any[] = []
      if (opts.before) {
        sql += ' AND valid_until < ?'
        params.push(opts.before)
      }
      const { count } = db.prepare(sql).get(...params) as any

      if (opts.dryRun) {
        console.log(`Would remove ${count} expired memories`)
        return
      }

      let deleteSql = 'DELETE FROM memories WHERE valid_until IS NOT NULL'
      if (opts.before) {
        deleteSql += ' AND valid_until < ?'
      }
      db.prepare(deleteSql).run(...params)
      console.log(`Removed ${count} expired memories`)
    } finally {
      closeDatabase(db)
    }
  })

program.parse()
```

**Step 2: Build and test CLI manually**

```bash
pnpm build
node dist/index.js status
node dist/index.js search "test"
```

Expected: `status` shows `Total: 0`, `search` shows `No memories found.`

**Step 3: Commit**

```bash
git add src/index.ts bin/memrecall.js
git commit -m "feat: CLI — serve, search, status, list, get, export, backup, gc"
```

---

### Task 7: Integration Test

**Files:**
- Create: `src/integration.test.ts`

**Step 1: Write full integration test**

```typescript
// src/integration.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabase, closeDatabase } from './db.js'
import { createMemory, expireMemory } from './memories.js'
import { searchMemories, getTopMemories } from './search.js'
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import os from 'os'

const TEST_DB_DIR = path.join(os.tmpdir(), 'memrecall-integration-' + Date.now())
const TEST_DB_PATH = path.join(TEST_DB_DIR, 'memrecall.db')

describe('integration: full workflow', () => {
  let db: Database.Database

  beforeEach(() => {
    fs.mkdirSync(TEST_DB_DIR, { recursive: true })
    db = createDatabase(TEST_DB_PATH)
  })

  afterEach(() => {
    closeDatabase(db)
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true })
  })

  it('simulates real usage: remember → search → update → forget → search', () => {
    // 1. AI auto-remembers during conversations
    const m1 = createMemory(db, {
      type: 'decision',
      content: 'Use per-variant inventory tracking instead of per-product. More flexible than Odoo.',
      project: 'owt',
      tags: ['inventory', 'architecture'],
    })

    const m2 = createMemory(db, {
      type: 'feedback',
      content: 'Never use disabled buttons. Always allow click and show validation error.',
      project: 'owt',
    })

    const m3 = createMemory(db, {
      type: 'bug',
      content: 'After schema change: must run prisma generate + restart dev server or types are stale.',
      project: 'owt',
      tags: ['prisma'],
    })

    createMemory(db, {
      type: 'feedback',
      content: 'User prefers terse responses. No trailing summaries.',
    }) // global

    // 2. New conversation starts — AI loads top memories
    const top = getTopMemories(db, 'owt', 10)
    expect(top.length).toBe(4) // 3 owt + 1 global
    // Decision should be first (weight 1.0)
    expect(top[0].type).toBe('decision')

    // 3. AI searches for specific topic
    const inventoryResults = searchMemories(db, { query: 'inventory', projects: ['owt'] })
    expect(inventoryResults.length).toBeGreaterThan(0)
    expect(inventoryResults[0].content).toContain('per-variant')

    // 4. Decision changes — forget old, remember new
    expireMemory(db, m1.id)
    createMemory(db, {
      type: 'decision',
      content: 'Switched to per-product inventory tracking for simplicity. Variant-level was overkill.',
      project: 'owt',
      tags: ['inventory', 'architecture'],
    })

    // 5. Search should only find new decision
    const afterChange = searchMemories(db, { query: 'inventory tracking', projects: ['owt'] })
    expect(afterChange.length).toBe(1)
    expect(afterChange[0].content).toContain('per-product')

    // 6. Cross-project search
    createMemory(db, {
      type: 'decision',
      content: 'API returns price including VAT for all endpoints.',
      project: 'thinkpro-api',
    })

    const crossProject = searchMemories(db, { query: 'VAT', projects: ['owt', 'thinkpro-api'] })
    expect(crossProject.length).toBe(1)
    expect(crossProject[0].project).toBe('thinkpro-api')
  })

  it('access tracking boosts frequently recalled memories', () => {
    createMemory(db, { type: 'decision', content: 'Important decision about databases', project: 'test' })
    createMemory(db, { type: 'decision', content: 'Important decision about caching', project: 'test' })

    // Search "databases" 5 times to boost its access count
    for (let i = 0; i < 5; i++) {
      searchMemories(db, { query: 'databases', projects: ['test'] })
    }

    // Now get top memories — "databases" should rank higher despite same weight/age
    const top = getTopMemories(db, 'test', 2)
    expect(top[0].content).toContain('databases')
    expect(top[0].accessCount).toBe(6) // 5 searches + 1 from getTopMemories
  })
})
```

**Step 2: Run all tests**

```bash
pnpm test
```

Expected: All tests PASS.

**Step 3: Commit**

```bash
git add src/integration.test.ts
git commit -m "test: integration test — full workflow with cross-project search"
```

---

### Task 8: Manual Testing with Real MCP Client

**Step 1: Build and link globally**

```bash
cd ~/Desktop/vt7/memrecall
pnpm build
npm link
```

**Step 2: Verify CLI works**

```bash
memrecall status
memrecall search "test"
memrecall backup
```

**Step 3: Add to Claude Code**

```bash
claude mcp add memrecall -e MEMRECALL_PROJECT=test -- memrecall serve
```

**Step 4: Test in Claude Code conversation**

Start a new Claude Code conversation and verify:
- Claude calls `memrecall_recall` at start (should see "No memories found")
- Tell Claude a decision → verify it calls `memrecall_remember`
- Start another conversation → verify Claude recalls the decision
- Tell Claude to forget it → verify it calls `memrecall_forget`

**Step 5: Commit any fixes from manual testing**

```bash
git add -A
git commit -m "fix: adjustments from manual MCP testing"
```

---

### Task 9: README

**Files:**
- Create: `README.md`

**Step 1: Write README**

```markdown
# memrecall

Long-term memory for AI assistants. One command to install, works forever.

## Install

\`\`\`bash
npm install -g memrecall
\`\`\`

## Setup

### Claude Code

\`\`\`bash
claude mcp add memrecall -e MEMRECALL_PROJECT=myproject -- memrecall serve
\`\`\`

### Cursor / Windsurf

Add to your MCP settings:

\`\`\`json
{
  "mcpServers": {
    "memrecall": {
      "command": "memrecall",
      "args": ["serve"],
      "env": { "MEMRECALL_PROJECT": "myproject" }
    }
  }
}
\`\`\`

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

\`\`\`bash
memrecall serve                          # Start MCP server
memrecall search "inventory"             # Search memories
memrecall search "VAT" --project owt     # Search specific project
memrecall status                         # Overview stats
memrecall list --project owt             # List recent memories
memrecall get <id>                       # View specific memory
memrecall backup                         # Backup database
memrecall export --project owt           # Export to JSON
memrecall import memories.json           # Import from JSON
memrecall gc --expired --before 2025-01  # Clean up old expired memories
\`\`\`

## License

MIT
\`\`\`

**Step 2: Commit**

\`\`\`bash
git add README.md
git commit -m "docs: README with install, setup, and CLI reference"
\`\`\`

---

### Summary

| Task | Description | Tests |
|------|-------------|-------|
| 1 | Project scaffolding | — |
| 2 | Database layer (SQLite + WAL + FTS5 + migration) | 7 tests |
| 3 | Memory CRUD with FTS5 sync | 10 tests |
| 4 | Search + combined ranking | 8 tests |
| 5 | MCP server (5 tools + resource) | — |
| 6 | CLI (serve, search, status, list, get, export, backup, gc) | — |
| 7 | Integration test | 2 tests |
| 8 | Manual MCP testing | — |
| 9 | README | — |

**Total: ~27 automated tests, 9 tasks, ~8 commits.**
