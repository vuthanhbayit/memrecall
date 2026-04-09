import Database from 'better-sqlite3'
import { nanoid } from 'nanoid'
import type { Triple, TripleRow, CreateTripleInput, QueryTripleInput } from './types.js'

// --- Validation ---

function validateNonEmpty(value: string, field: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new Error(`${field} cannot be empty`)
  return trimmed
}

// --- Row conversion ---

export function rowToTriple(row: TripleRow): Triple {
  return {
    id: row.id,
    subject: row.subject,
    predicate: row.predicate,
    object: row.object,
    project: row.project,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    createdAt: row.created_at,
  }
}

// --- CRUD ---

export function addTriple(db: Database.Database, input: CreateTripleInput): Triple {
  const subject = validateNonEmpty(input.subject, 'subject')
  const predicate = validateNonEmpty(input.predicate, 'predicate').toLowerCase()
  const object = validateNonEmpty(input.object, 'object')

  // Check for existing active duplicate
  const existing = db.prepare(`
    SELECT * FROM triples
    WHERE subject = ? AND predicate = ? AND object = ? AND valid_until IS NULL
  `).get(subject, predicate, object) as TripleRow | undefined

  if (existing) return rowToTriple(existing)

  const id = nanoid(12)
  const now = new Date().toISOString()
  const validFrom = input.validFrom || now
  const project = input.project?.trim() || null

  db.prepare(`
    INSERT INTO triples (id, subject, predicate, object, project, valid_from, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, subject, predicate, object, project, validFrom, now)

  return rowToTriple(
    db.prepare('SELECT * FROM triples WHERE id = ?').get(id) as TripleRow,
  )
}

export function queryTriples(db: Database.Database, input: QueryTripleInput): Triple[] {
  const conditions: string[] = ['(subject = ? OR object = ?)']
  const params: unknown[] = [input.entity, input.entity]

  if (!input.includeExpired) {
    conditions.push('valid_until IS NULL')
  }

  if (input.predicate) {
    conditions.push('predicate = ?')
    params.push(input.predicate.trim().toLowerCase())
  }

  if (input.project) {
    conditions.push('project = ?')
    params.push(input.project)
  }

  const sql = `SELECT * FROM triples WHERE ${conditions.join(' AND ')} ORDER BY valid_from DESC`
  const rows = db.prepare(sql).all(...params) as TripleRow[]
  return rows.map(rowToTriple)
}

export function invalidateTriple(
  db: Database.Database,
  input: { subject: string; predicate: string; object: string },
): boolean {
  const subject = validateNonEmpty(input.subject, 'subject')
  const predicate = validateNonEmpty(input.predicate, 'predicate').toLowerCase()
  const object = validateNonEmpty(input.object, 'object')

  const now = new Date().toISOString()
  const result = db.prepare(`
    UPDATE triples SET valid_until = ?
    WHERE subject = ? AND predicate = ? AND object = ? AND valid_until IS NULL
  `).run(now, subject, predicate, object)

  return result.changes > 0
}

export function getTimeline(db: Database.Database, entity: string, project?: string): Triple[] {
  const conditions: string[] = ['(subject = ? OR object = ?)']
  const params: unknown[] = [entity, entity]

  if (project) {
    conditions.push('project = ?')
    params.push(project)
  }

  const sql = `SELECT * FROM triples WHERE ${conditions.join(' AND ')} ORDER BY valid_from ASC`
  const rows = db.prepare(sql).all(...params) as TripleRow[]
  return rows.map(rowToTriple)
}

export function searchTriplesByQuery(
  db: Database.Database,
  query: string,
  projects?: string[],
): Triple[] {
  const pattern = `%${query}%`
  const conditions: string[] = [
    '(subject LIKE ? COLLATE NOCASE OR object LIKE ? COLLATE NOCASE)',
    'valid_until IS NULL',
  ]
  const params: unknown[] = [pattern, pattern]

  if (projects && projects.length > 0) {
    const placeholders = projects.map(() => '?').join(', ')
    conditions.push(`project IN (${placeholders})`)
    params.push(...projects)
  }

  const sql = `SELECT * FROM triples WHERE ${conditions.join(' AND ')} ORDER BY valid_from DESC LIMIT 10`
  const rows = db.prepare(sql).all(...params) as TripleRow[]
  return rows.map(rowToTriple)
}
