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
