import Database from 'better-sqlite3'
import type { Memory, SearchInput, MemoryType, MemoryRow } from './types.js'
import { rowToMemory, halfLifeDecaySQL } from './memories.js'

function sanitizeFtsQuery(query: string): string {
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
    return getTopMemories(db, projects ?? null, limit, type)
  }

  const sanitized = sanitizeFtsQuery(query)
  if (!sanitized) return []

  const decay = halfLifeDecaySQL('m.')

  let sql = `
    SELECT m.*, memories_fts.rank AS fts_rank
    FROM memories_fts
    JOIN memories m ON m.rowid = memories_fts.rowid
    WHERE memories_fts MATCH ?
      AND m.valid_until IS NULL
  `
  const params: any[] = [sanitized]

  if (projects && projects.length > 0) {
    const placeholders = projects.map(() => '?').join(', ')
    sql += ` AND (m.project IN (${placeholders}) OR m.project IS NULL)`
    params.push(...projects)
  }

  if (type) {
    sql += ' AND m.type = ?'
    params.push(type)
  }

  sql += `
    ORDER BY
      (fts_rank * -1)
      * m.weight
      * ${decay}
      * (1.0 + min(m.access_count, 10) * 0.1)
      DESC
    LIMIT ?
  `
  params.push(limit)

  let results: Memory[]
  try {
    results = (db.prepare(sql).all(...params) as MemoryRow[]).map(rowToMemory)
  } catch (e: unknown) {
    console.error('[memrecall] FTS5 query error:', e instanceof Error ? e.message : e)
    results = []
  }

  updateAccessCounts(db, results.map(r => r.id))
  for (const r of results) { r.accessCount++ }

  return results
}

export function getTopMemories(db: Database.Database, projects: string[] | null, limit: number, type?: MemoryType): Memory[] {
  const decay = halfLifeDecaySQL('')

  let sql = `
    SELECT *,
      weight
      * ${decay}
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

  const results = (db.prepare(sql).all(...params) as MemoryRow[]).map(rowToMemory)

  updateAccessCounts(db, results.map(r => r.id))
  for (const r of results) { r.accessCount++ }

  return results
}
