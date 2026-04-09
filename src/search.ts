import Database from 'better-sqlite3'
import type { Memory, SearchInput, MemoryType, MemoryRow, Triple } from './types.js'
import { rowToMemory, halfLifeDecaySQL } from './memories.js'
import { embedText, bufferToEmbedding, cosineSimilarity, getProvider } from './embed.js'
import { searchTriplesByQuery } from './kg.js'

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

// --- FTS5 search (extracted helper) ---

function ftsSearch(
  db: Database.Database,
  sanitizedQuery: string,
  projects: string[] | undefined,
  type: MemoryType | undefined,
  limit: number,
): Memory[] {
  const decay = halfLifeDecaySQL('m.')

  let sql = `
    SELECT m.*, memories_fts.rank AS fts_rank
    FROM memories_fts
    JOIN memories m ON m.rowid = memories_fts.rowid
    WHERE memories_fts MATCH ?
      AND m.valid_until IS NULL
  `
  const params: any[] = [sanitizedQuery]

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

  try {
    return (db.prepare(sql).all(...params) as MemoryRow[]).map(rowToMemory)
  } catch (e: unknown) {
    console.error('[memrecall] FTS5 query error:', e instanceof Error ? e.message : e)
    return []
  }
}

// --- Vector search ---

async function vectorSearch(db: Database.Database, query: string, options: {
  projects?: string[]
  type?: MemoryType
  limit?: number
}): Promise<{ memory: Memory; similarity: number }[]> {
  const provider = await getProvider()
  if (!provider) return []

  const queryEmbedding = await embedText(query)
  if (!queryEmbedding) return []

  let sql = 'SELECT * FROM memories WHERE valid_until IS NULL AND embedding IS NOT NULL'
  const params: any[] = []

  if (options.projects?.length) {
    const placeholders = options.projects.map(() => '?').join(', ')
    sql += ` AND (project IN (${placeholders}) OR project IS NULL)`
    params.push(...options.projects)
  }
  if (options.type) {
    sql += ' AND type = ?'
    params.push(options.type)
  }

  const rows = db.prepare(sql).all(...params) as MemoryRow[]

  const scored = rows
    .filter(row => row.embedding != null)
    .map(row => ({
      memory: rowToMemory(row),
      similarity: cosineSimilarity(queryEmbedding, bufferToEmbedding(row.embedding as Buffer)),
    }))

  scored.sort((a, b) => b.similarity - a.similarity)
  return scored.slice(0, options.limit || 10)
}

// --- Reciprocal Rank Fusion ---

export function reciprocalRankFusion(
  ftsResults: Memory[],
  vecResults: { memory: Memory; similarity: number }[],
  k: number = 60,
): Memory[] {
  const scores = new Map<string, { memory: Memory; score: number }>()

  // Score from FTS5 results (ranked by BM25)
  ftsResults.forEach((mem, rank) => {
    const rrfScore = 1 / (k + rank + 1)
    scores.set(mem.id, { memory: mem, score: rrfScore })
  })

  // Score from vector results (ranked by cosine similarity)
  vecResults.forEach((item, rank) => {
    const rrfScore = 1 / (k + rank + 1)
    const existing = scores.get(item.memory.id)
    if (existing) {
      existing.score += rrfScore
    } else {
      scores.set(item.memory.id, { memory: item.memory, score: rrfScore })
    }
  })

  // Sort by combined RRF score DESC
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .map(s => s.memory)
}

// --- Hybrid search ---

export async function searchMemories(db: Database.Database, input: SearchInput): Promise<Memory[]> {
  const { query, projects, type, limit = 10 } = input

  if (!query || query.trim().length === 0) {
    return getTopMemories(db, projects ?? null, limit, type)
  }

  const sanitized = sanitizeFtsQuery(query)

  // FTS5 search
  const ftsResults = sanitized ? ftsSearch(db, sanitized, projects, type, limit) : []

  // Vector search (only if an embedding provider is available)
  const vecResults = await vectorSearch(db, query, { projects, type, limit })

  // Merge results
  let results: Memory[]
  if (ftsResults.length > 0 && vecResults.length > 0) {
    results = reciprocalRankFusion(ftsResults, vecResults).slice(0, limit)
  } else if (vecResults.length > 0) {
    results = vecResults.slice(0, limit).map(v => v.memory)
  } else {
    results = ftsResults
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

// --- Enhanced Recall (hybrid search + KG integration) ---

export interface EnhancedRecallResult {
  memories: Memory[]
  triples: Triple[] | null
}

export async function enhancedRecall(db: Database.Database, input: SearchInput): Promise<EnhancedRecallResult> {
  const memories = await searchMemories(db, input)

  // Smart KG integration: only search if there's a query
  let triples: Triple[] | null = null
  if (input.query && input.query.trim().length > 0) {
    const found = searchTriplesByQuery(db, input.query, input.projects ?? undefined)
    if (found.length > 0) {
      triples = found
    }
  }

  return { memories, triples }
}
