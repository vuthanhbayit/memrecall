import Database from 'better-sqlite3'
import type { MineOptions, MineResult, ConversationParser, MinedMemory } from './types.js'
import type { MemoryRow } from '../types.js'
import { ClaudeCodeParser } from './claude-code-parser.js'
import { extractMemories, wordOverlap } from './extractor.js'
import { createMemory, rowToMemory } from '../memories.js'

const PARSERS: ConversationParser[] = [
  new ClaudeCodeParser(),
]

const DEDUP_THRESHOLD = 0.7

/**
 * Light FTS5 search for dedup only — no vector search, no access tracking.
 * Avoids N+1 performance issue of calling full searchMemories per memory.
 */
function ftsDedup(db: Database.Database, content: string): boolean {
  const queryWords = content.split(/\s+/).slice(0, 5).join(' ')
  if (!queryWords.trim()) return false

  const sanitized = queryWords
    .replace(/['"]/g, '')
    .split(/\s+/)
    .filter(t => t.length > 0)
    .map(t => `"${t}"`)
    .join(' ')
  if (!sanitized) return false

  try {
    const rows = db.prepare(`
      SELECT m.content FROM memories_fts
      JOIN memories m ON m.rowid = memories_fts.rowid
      WHERE memories_fts MATCH ? AND m.valid_until IS NULL
      LIMIT 3
    `).all(sanitized) as { content: string }[]

    return rows.some(row => wordOverlap(content, row.content) > DEDUP_THRESHOLD)
  } catch {
    return false
  }
}

/**
 * Mine conversations from a path and save extracted memories to the database.
 */
export async function mine(db: Database.Database, targetPath: string, options: MineOptions = {}): Promise<MineResult> {
  const result: MineResult = { parsed: 0, extracted: 0, saved: 0, skipped: 0 }

  // Find the right parser
  let parser: ConversationParser | undefined

  if (options.format) {
    parser = PARSERS.find(p => p.name === options.format)
    if (!parser) {
      throw new Error(`Unknown format: ${options.format}. Available: ${PARSERS.map(p => p.name).join(', ')}`)
    }
  } else {
    for (const p of PARSERS) {
      if (await p.detect(targetPath)) {
        parser = p
        break
      }
    }
    if (!parser) {
      throw new Error(`No parser detected for path: ${targetPath}. Try specifying --format explicitly.`)
    }
  }

  // Parse and extract
  const extract = options.extract ?? false

  for await (const conversation of parser.parse(targetPath)) {
    result.parsed++

    const memories = extractMemories(conversation, extract)
    result.extracted += memories.length

    for (const memory of memories) {
      if (ftsDedup(db, memory.content)) {
        result.skipped++
        continue
      }

      if (options.dryRun) {
        result.saved++
        continue
      }

      const project = options.project || conversation.metadata?.project
      createMemory(db, {
        type: memory.type,
        content: memory.content,
        project,
        tags: memory.tags,
      })
      result.saved++
    }
  }

  return result
}

export { extractMemories, wordOverlap } from './extractor.js'
export type { MineOptions, MineResult, Conversation, ConversationParser, MinedMemory, Message } from './types.js'
