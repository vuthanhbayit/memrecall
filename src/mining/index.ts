import type Database from 'better-sqlite3'
import type { MineOptions, MineResult, ConversationParser } from './types.js'
import { ClaudeCodeParser } from './claude-code-parser.js'
import { extractMemories, wordOverlap } from './extractor.js'
import { createMemory } from '../memories.js'
import { searchMemories } from '../search.js'

const PARSERS: ConversationParser[] = [
  new ClaudeCodeParser(),
]

const DEDUP_THRESHOLD = 0.7

/**
 * Mine conversations from a path and save extracted memories to the database.
 *
 * Flow:
 * 1. Detect format: try each parser's detect(), use first match
 * 2. Parse conversations via parser
 * 3. For each conversation, extract memories (raw or smart mode)
 * 4. Dedup: search FTS5 for similar content, skip if >70% word overlap
 * 5. Save via createMemory()
 * 6. Return stats
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
      // Dedup: check if similar memory already exists
      if (await isDuplicate(db, memory.content)) {
        result.skipped++
        continue
      }

      if (options.dryRun) {
        result.saved++
        continue
      }

      // Save to database
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

/**
 * Check if a memory with similar content already exists in the database.
 * Uses FTS5 search and word overlap comparison.
 */
async function isDuplicate(db: Database.Database, content: string): Promise<boolean> {
  // Take first few meaningful words for search query
  const queryWords = content.split(/\s+/).slice(0, 5).join(' ')
  if (!queryWords.trim()) return false

  const existing = await searchMemories(db, { query: queryWords, limit: 3 })

  for (const mem of existing) {
    if (wordOverlap(content, mem.content) > DEDUP_THRESHOLD) {
      return true
    }
  }

  return false
}

export { extractMemories, wordOverlap } from './extractor.js'
export type { MineOptions, MineResult, Conversation, ConversationParser, MinedMemory, Message } from './types.js'
