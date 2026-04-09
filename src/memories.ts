import Database from 'better-sqlite3'
import { nanoid } from 'nanoid'
import type { Memory, CreateMemoryInput, UpdateMemoryInput, MemoryStats, MemoryType, MemoryRow } from './types.js'
import { TYPE_WEIGHTS, TYPE_HALF_LIFE_DAYS, MAX_CONTENT_LENGTH, MEMORY_TYPES } from './types.js'
import { embedText, embeddingToBuffer } from './embed.js'

function normalizeProject(name: string): string | null {
  const normalized = name.toLowerCase().trim().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  return normalized || null
}

export function validateContent(content: string): void {
  if (content.trim().length === 0) throw new Error('Content cannot be empty')
  if (content.length > MAX_CONTENT_LENGTH) throw new Error(`Content exceeds ${MAX_CONTENT_LENGTH} character limit`)
}

function tagsToFts(tags: string[] | null | undefined): string {
  return (tags || []).join(' ')
}

/** SQL fragment for half-life decay scoring */
export function halfLifeDecaySQL(col: string = ''): string {
  return `(1.0 / (1 + (julianday('now') - julianday(${col}created_at)) /
      CASE ${col}type
        WHEN 'decision' THEN ${TYPE_HALF_LIFE_DAYS.decision}
        WHEN 'feedback' THEN ${TYPE_HALF_LIFE_DAYS.feedback}
        WHEN 'bug' THEN ${TYPE_HALF_LIFE_DAYS.bug}
        WHEN 'reference' THEN ${TYPE_HALF_LIFE_DAYS.reference}
        ELSE ${TYPE_HALF_LIFE_DAYS.context}
      END))`
}

/** Build MCP error response from caught error */
export function errorResponse(e: unknown) {
  const message = e instanceof Error ? e.message : 'Unknown error'
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: true, message }) }], isError: true as const }
}

export function rowToMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    type: row.type as MemoryType,
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
    const result = db.prepare(`
      INSERT INTO memories (id, type, content, weight, project, tags, valid_from, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.type, input.content, weight, project, tags ? JSON.stringify(tags) : null, now, now)

    db.prepare(`
      INSERT INTO memories_fts (rowid, content, tags)
      VALUES (?, ?, ?)
    `).run(result.lastInsertRowid, input.content, tagsToFts(tags))
  })()

  return getMemory(db, id)!
}

/**
 * Create memory + embed content (non-blocking).
 * Memory is saved regardless of embedding success.
 */
export async function createMemoryWithEmbedding(db: Database.Database, input: CreateMemoryInput): Promise<Memory> {
  const memory = createMemory(db, input)

  try {
    const embedding = await embedText(input.content)
    if (embedding) {
      db.prepare('UPDATE memories SET embedding = ? WHERE id = ?')
        .run(embeddingToBuffer(embedding), memory.id)
    }
  } catch {
    // Embedding failed — memory is still saved, just without embedding
  }

  return memory
}

export function getMemory(db: Database.Database, id: string): Memory | null {
  const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined
  return row ? rowToMemory(row) : null
}

export function updateMemory(db: Database.Database, input: UpdateMemoryInput): Memory {
  validateContent(input.content)

  const old = db.prepare('SELECT rowid, * FROM memories WHERE id = ?').get(input.id) as (MemoryRow & { rowid: number }) | undefined
  if (!old) throw new Error(`Memory not found: ${input.id}`)

  const oldTags = old.tags ? JSON.parse(old.tags) : null

  db.transaction(() => {
    db.prepare('UPDATE memories SET content = ? WHERE id = ?').run(input.content, input.id)

    db.prepare("INSERT INTO memories_fts (memories_fts, rowid, content, tags) VALUES ('delete', ?, ?, ?)")
      .run(old.rowid, old.content, tagsToFts(oldTags))
    db.prepare('INSERT INTO memories_fts (rowid, content, tags) VALUES (?, ?, ?)')
      .run(old.rowid, input.content, tagsToFts(oldTags))
  })()

  return getMemory(db, input.id)!
}

export function expireMemory(db: Database.Database, id: string): void {
  const old = db.prepare('SELECT rowid, * FROM memories WHERE id = ?').get(id) as (MemoryRow & { rowid: number }) | undefined
  if (!old) throw new Error(`Memory not found: ${id}`)

  const oldTags = old.tags ? JSON.parse(old.tags) : null

  db.transaction(() => {
    db.prepare('UPDATE memories SET valid_until = ? WHERE id = ?').run(new Date().toISOString(), id)

    db.prepare("INSERT INTO memories_fts (memories_fts, rowid, content, tags) VALUES ('delete', ?, ?, ?)")
      .run(old.rowid, old.content, tagsToFts(oldTags))
  })()
}

export function getStats(db: Database.Database, project?: string): MemoryStats {
  const where = project ? 'WHERE project = ?' : ''
  const params = project ? [project] : []

  const rows = db.prepare(`
    SELECT type, valid_until IS NULL as is_active, COUNT(*) as count
    FROM memories ${where}
    GROUP BY type, is_active
  `).all(...params) as { type: string; is_active: number; count: number }[]

  let total = 0
  let active = 0
  const byType: Record<string, number> = {}
  for (const t of MEMORY_TYPES) byType[t] = 0

  for (const row of rows) {
    total += row.count
    if (row.is_active) active += row.count
    byType[row.type] = (byType[row.type] || 0) + row.count
  }

  const byProject: Record<string, number> = {}
  const projectRows = db.prepare(`SELECT project, COUNT(*) as count FROM memories ${where} GROUP BY project`).all(...params) as { project: string | null; count: number }[]
  for (const row of projectRows) {
    byProject[row.project || '(global)'] = row.count
  }

  return { total, active, expired: total - active, byType: byType as Record<MemoryType, number>, byProject }
}

export function exportMemories(db: Database.Database, project?: string): MemoryRow[] {
  let sql = 'SELECT * FROM memories'
  const params: any[] = []
  if (project) { sql += ' WHERE project = ?'; params.push(project) }
  sql += ' ORDER BY created_at DESC'
  return db.prepare(sql).all(...params) as MemoryRow[]
}

function validateImportRow(row: any): string | null {
  if (!row.id || typeof row.id !== 'string') return 'missing or invalid id'
  if (!row.content || typeof row.content !== 'string') return 'missing or invalid content'
  if (!row.type || !MEMORY_TYPES.includes(row.type as MemoryType)) return `invalid type: ${row.type}`
  if (row.content.trim().length === 0) return 'empty content'
  if (row.content.length > MAX_CONTENT_LENGTH) return `content exceeds ${MAX_CONTENT_LENGTH} chars`
  if (!row.valid_from || typeof row.valid_from !== 'string') return 'missing valid_from'
  if (!row.created_at || typeof row.created_at !== 'string') return 'missing created_at'
  return null
}

export function importMemories(db: Database.Database, rows: any[]): { imported: number; skipped: number; errors: string[] } {
  let imported = 0
  let skipped = 0
  const errors: string[] = []

  db.transaction(() => {
    for (const row of rows) {
      const err = validateImportRow(row)
      if (err) { errors.push(`Row ${row.id || '?'}: ${err}`); skipped++; continue }

      const exists = db.prepare('SELECT id FROM memories WHERE id = ?').get(row.id)
      if (exists) { skipped++; continue }

      db.prepare(`
        INSERT INTO memories (id, type, content, weight, project, tags, valid_from, valid_until, access_count, last_accessed_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(row.id, row.type, row.content, row.weight ?? TYPE_WEIGHTS[row.type as MemoryType] ?? 0.5, row.project, row.tags, row.valid_from, row.valid_until, row.access_count || 0, row.last_accessed_at, row.created_at)

      if (!row.valid_until) {
        const inserted = db.prepare('SELECT rowid FROM memories WHERE id = ?').get(row.id) as any
        const tagsText = row.tags ? (typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags).join(' ') : ''
        db.prepare('INSERT INTO memories_fts (rowid, content, tags) VALUES (?, ?, ?)').run(inserted.rowid, row.content, tagsText)
      }
      imported++
    }
  })()

  return { imported, skipped, errors }
}

export function gcExpiredMemories(db: Database.Database, before?: string): { removed: number } {
  let whereSql = 'WHERE valid_until IS NOT NULL'
  const params: any[] = []
  if (before) { whereSql += ' AND valid_until < ?'; params.push(before) }

  const toDelete = db.prepare(`SELECT rowid, content, tags FROM memories ${whereSql}`).all(...params) as any[]
  if (toDelete.length === 0) return { removed: 0 }

  db.transaction(() => {
    for (const row of toDelete) {
      try {
        const tagsText = row.tags ? JSON.parse(row.tags).join(' ') : ''
        db.prepare("INSERT INTO memories_fts (memories_fts, rowid, content, tags) VALUES ('delete', ?, ?, ?)").run(row.rowid, row.content, tagsText)
      } catch { /* FTS entry may already be removed by expireMemory */ }
    }
    db.prepare(`DELETE FROM memories ${whereSql}`).run(...params)
  })()

  return { removed: toDelete.length }
}
