# memrecall v1 — Bugfixes Before Implementation

These bugs were found during code review of `docs/plans/2026-04-08-memrecall-v1.md`.
Apply ALL fixes to the plan file before implementing.

---

## BUG 1 (HIGH): Use `result.lastInsertRowid` instead of `last_insert_rowid()`

**File in plan:** `src/memories.ts` (Task 3 — createMemory function)

**Current (fragile):**
```typescript
db.prepare(`
  INSERT INTO memories (id, type, content, weight, project, tags, valid_from, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`).run(id, input.type, input.content, weight, project, tags ? JSON.stringify(tags) : null, now, now)

db.prepare(`
  INSERT INTO memories_fts (rowid, content, tags)
  VALUES (last_insert_rowid(), ?, ?)
`).run(input.content, tagsToFts(tags))
```

**Fix:**
```typescript
const result = db.prepare(`
  INSERT INTO memories (id, type, content, weight, project, tags, valid_from, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`).run(id, input.type, input.content, weight, project, tags ? JSON.stringify(tags) : null, now, now)

db.prepare(`
  INSERT INTO memories_fts (rowid, content, tags)
  VALUES (?, ?, ?)
`).run(result.lastInsertRowid, input.content, tagsToFts(tags))
```

---

## BUG 2 (CRITICAL): 3+ tests will FAIL — queries use `OR` which gets wrapped as literal

**File in plan:** `src/search.test.ts` (Task 4)

`sanitizeFtsQuery` wraps every word in quotes and joins with space (implicit AND).
So `'buttons OR terse'` becomes `"buttons" "OR" "terse"` — searches for all 3 words literally. No memory contains literal "OR".

**Fix all test queries:**

Replace:
```typescript
it('filters by project + includes globals', () => {
  const results = searchMemories(db, { query: 'buttons OR terse', projects: ['owt'] })
  expect(results.length).toBe(2)
})
```
With:
```typescript
it('filters by project + includes globals', () => {
  const results = searchMemories(db, { query: 'disabled buttons', projects: ['owt'] })
  expect(results.length).toBeGreaterThan(0)
  expect(results[0].content).toContain('buttons')

  // Global memories also included when searching project
  const results2 = searchMemories(db, { query: 'terse responses', projects: ['owt'] })
  expect(results2.length).toBeGreaterThan(0)
  expect(results2[0].project).toBeNull() // global memory
})
```

Replace:
```typescript
it('filters by type', () => {
  const results = searchMemories(db, { query: 'inventory OR SQLite', type: 'decision' })
  expect(results.every(r => r.type === 'decision')).toBe(true)
})
```
With:
```typescript
it('filters by type', () => {
  const results = searchMemories(db, { query: 'inventory', type: 'decision' })
  expect(results.length).toBeGreaterThan(0)
  expect(results.every(r => r.type === 'decision')).toBe(true)
})
```

Replace:
```typescript
it('respects limit', () => {
  const results = searchMemories(db, { query: 'use OR never', limit: 2 })
  expect(results.length).toBe(2)
})
```
With:
```typescript
it('respects limit', () => {
  // Search a common word that matches multiple memories
  const results = searchMemories(db, { query: 'tracking buttons schema SQLite terse', limit: 2 })
  expect(results.length).toBeLessThanOrEqual(2)
})
```
Note: This test is hard to write with AND-only FTS. Alternative: seed more memories with a common word, then test limit.

Better approach — add shared word to test data:
```typescript
// In beforeEach, add memories that share a common word:
createMemory(db, { type: 'decision', content: 'Important: Use per-variant inventory tracking', project: 'owt' })
createMemory(db, { type: 'feedback', content: 'Important: Never use disabled buttons', project: 'owt' })
createMemory(db, { type: 'bug', content: 'Important: Prisma generate must run after schema change', project: 'owt' })

// Then test:
it('respects limit', () => {
  const results = searchMemories(db, { query: 'Important', limit: 2 })
  expect(results.length).toBe(2)
})
```

---

## BUG 3 (HIGH): `import` command not wrapped in transaction

**File in plan:** `src/index.ts` (Task 6 — import command)

**Fix:** Wrap the entire import loop in `db.transaction()`:

```typescript
.action((file, opts) => {
    if (program.opts().verbose) setVerbose(true)
    const db = createDatabase()
    try {
      const raw = fs.readFileSync(file, 'utf-8')
      let rows: any[]
      try {
        rows = JSON.parse(raw)
      } catch {
        console.error('Invalid JSON file')
        process.exit(1)
      }

      if (opts.dryRun) {
        console.log(`Would import ${rows.length} memories`)
        return
      }

      let imported = 0
      let skipped = 0

      db.transaction(() => {
        for (const row of rows) {
          const exists = db.prepare('SELECT id FROM memories WHERE id = ?').get(row.id)
          if (exists) { skipped++; continue }

          const result = db.prepare(`
            INSERT INTO memories (id, type, content, weight, project, tags, valid_from, valid_until, access_count, last_accessed_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(row.id, row.type, row.content, row.weight, row.project, row.tags, row.valid_from, row.valid_until, row.access_count || 0, row.last_accessed_at, row.created_at)

          if (!row.valid_until) {
            const tagsText = row.tags ? JSON.parse(row.tags).join(' ') : ''
            db.prepare('INSERT INTO memories_fts (rowid, content, tags) VALUES (?, ?, ?)').run(result.lastInsertRowid, row.content, tagsText)
          }

          imported++
        }
      })()

      console.log(`Imported ${imported} memories (${skipped} skipped — already exist)`)
    } finally {
      closeDatabase(db)
    }
  })
```

---

## BUG 4 (MEDIUM): `server.resource()` may have wrong API signature

**File in plan:** `src/server.ts` (Task 5)

MCP SDK v1.29 `McpServer.resource()` signature:
```typescript
server.resource(name, uri, handler)
// or
server.resource(name, uri, metadata, handler)
```

**Current (may be wrong):**
```typescript
server.resource(
  'memrecall://context',
  'Top memories for the current project...',
  async () => { ... }
)
```

**Fix:** Verify actual SDK signature at implementation time. Likely needs:
```typescript
server.resource(
  'context',                  // name (identifier)
  'memrecall://context',      // URI template or string
  async (uri) => {            // handler receives URI
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
```

---

## BUG 5 (MEDIUM): `getTopMemories` ignores `type` filter and only takes first project

**File in plan:** `src/server.ts` (Task 5 — memrecall_recall tool) + `src/search.ts` (Task 4)

**Current:**
```typescript
: getTopMemories(db, projects?.[0] ?? null, params.limit ?? 15)
```

Ignores `params.type` and drops all projects except the first.

**Fix in `src/search.ts`:** Update `getTopMemories` signature:
```typescript
export function getTopMemories(
  db: Database.Database,
  projects: string[] | null,
  limit: number,
  type?: MemoryType
): Memory[] {
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

  if (projects && projects.length > 0) {
    const placeholders = projects.map(() => '?').join(', ')
    sql += ` AND (project IN (${placeholders}) OR project IS NULL)`
    params.push(...projects)
  }

  if (type) {
    sql += ' AND type = ?'
    params.push(type)
  }

  sql += ' ORDER BY score DESC LIMIT ?'
  params.push(limit)

  const results = db.prepare(sql).all(...params).map(rowToMemory)
  updateAccessCounts(db, results.map(r => r.id))
  return results
}
```

**Fix in `src/server.ts`:** Update the recall tool handler:
```typescript
: getTopMemories(db, projects ?? null, params.limit ?? 15, params.type as MemoryType | undefined)
```

**Fix in all callers** (CLI `list`, `status`, etc.): Update to pass `string[] | null`:
```typescript
// CLI list command
const results = getTopMemories(db, opts.project ? [opts.project] : null, parseInt(opts.limit))
```

---

## BUG 6 (MEDIUM): Backup command double-closes DB

**File in plan:** `src/index.ts` (Task 6 — backup command)

**Fix:**
```typescript
.action((opts) => {
    const dbPath = getDefaultDbPath()
    if (!fs.existsSync(dbPath)) {
      console.error('No database found at', dbPath)
      process.exit(1)
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupPath = opts.output || path.join(path.dirname(dbPath), `memrecall-backup-${timestamp}.db`)

    // WAL checkpoint then close before copy
    const db = createDatabase()
    try {
      db.pragma('wal_checkpoint(TRUNCATE)')
    } finally {
      closeDatabase(db)
    }

    fs.copyFileSync(dbPath, backupPath)
    console.log(`Backup created: ${backupPath}`)
  })
```

---

## BUG 7 (LOW): `normalizeProject` returns empty string instead of null

**File in plan:** `src/memories.ts` (Task 3)

**Fix:**
```typescript
function normalizeProject(name: string): string | null {
  const normalized = name.toLowerCase().trim().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  if (!normalized) return null
  return normalized
}
```

Also update `createMemory`:
```typescript
const project = input.project ? normalizeProject(input.project) : null
```
This already works since `normalizeProject` now returns `null` for invalid input.

---

## BUG 8 (LOW): `reason` param in `expireMemory` is dead code

**File in plan:** `src/memories.ts` (Task 3)

`reason` is accepted but never stored (no DB column for it).

**Fix:** Remove `reason` parameter from `expireMemory` and `memrecall_forget` tool. If we want to keep it for future use, add a comment `// TODO: store reason when schema supports it`.

Simpler: just remove it.
```typescript
export function expireMemory(db: Database.Database, id: string): void {
```

And in server.ts `memrecall_forget` tool: remove `reason` from the handler call but keep it in the tool schema (useful for AI to explain why it's forgetting, even if we don't store it).

---

## BUG 9 (LOW): README in Task 9 still has `--expired` flag

**Fix:** In the README (Task 9), change:
```
memrecall gc --expired --before 2025-01
```
To:
```
memrecall gc --before 2025-01
```

---

## BUG 10 (LOW): `memrecall_remember` auto-fills default project for global memories

**File in plan:** `src/server.ts` (Task 5)

**Current:**
```typescript
project: params.project || (defaultProject ?? undefined),
```

When `MEMRECALL_PROJECT=owt` and user omits `project`, memory is saved as `project: 'owt'` instead of global.

**Fix:** Only use defaultProject if params.project is undefined (not just falsy). Let explicit empty string mean "global":
```typescript
project: params.project !== undefined ? params.project : (defaultProject ?? undefined),
```

And update tool description to clarify:
```
project: "Project identifier (lowercase slug). Omit to use default project. Set to empty string for global memory."
```
