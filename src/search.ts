import Database from 'better-sqlite3'
import type { Memory, SearchInput, MemoryType } from './types.js'
import { TYPE_HALF_LIFE_DAYS } from './types.js'
import { rowToMemory } from './memories.js'

function sanitizeFtsQuery(query: string): string {
  // Escape FTS5 special characters, wrap each term in quotes for safety
  // Preserves OR/AND/NOT operators for FTS5
  // Uses implicit AND (FTS5 default) — "VAT pricing" matches both terms
  const operators = new Set(['OR', 'AND', 'NOT'])
  return query
    .replace(/['"]/g, '')
    .split(/\s+/)
    .filter(t => t.length > 0)
    .map(t => operators.has(t) ? t : `"${t}"`)
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
    SELECT m.*, memories_fts.rank AS fts_rank
    FROM memories_fts
    JOIN memories m ON m.rowid = memories_fts.rowid
    WHERE memories_fts MATCH ?
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
      (fts_rank * -1)
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

  // Update access counts and reflect in returned results
  updateAccessCounts(db, results.map(r => r.id))
  for (const r of results) { r.accessCount++ }

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

  // Update access counts and reflect in returned results
  updateAccessCounts(db, results.map(r => r.id))
  for (const r of results) { r.accessCount++ }

  return results
}
