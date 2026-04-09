import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabase, closeDatabase } from './db.js'
import { createMemory } from './memories.js'
import { searchMemories, getTopMemories, reciprocalRankFusion } from './search.js'
import type { Memory } from './types.js'
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import os from 'os'

const TEST_DB_DIR = path.join(os.tmpdir(), 'memrecall-search-test-' + Date.now())
const TEST_DB_PATH = path.join(TEST_DB_DIR, 'memrecall.db')

function makeMemory(overrides: Partial<Memory> & { id: string }): Memory {
  return {
    type: 'decision',
    content: 'test content',
    weight: 1.0,
    project: null,
    tags: null,
    validFrom: new Date().toISOString(),
    validUntil: null,
    accessCount: 0,
    lastAccessedAt: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

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
    it('finds memories by keyword', async () => {
      const results = await searchMemories(db, { query: 'inventory' })
      expect(results.length).toBeGreaterThan(0)
      expect(results[0].content).toContain('inventory')
    })

    it('filters by project + includes globals', async () => {
      const results = await searchMemories(db, { query: 'buttons OR terse', projects: ['owt'] })
      // Should find 'disabled buttons' (owt) and 'terse responses' (global)
      expect(results.length).toBe(2)
    })

    it('filters by type', async () => {
      const results = await searchMemories(db, { query: 'inventory OR SQLite', type: 'decision' })
      expect(results.every(r => r.type === 'decision')).toBe(true)
    })

    it('respects limit', async () => {
      const results = await searchMemories(db, { query: 'use OR never', limit: 2 })
      expect(results.length).toBe(2)
    })

    it('finds by tag', async () => {
      const results = await searchMemories(db, { query: 'prisma' })
      expect(results.length).toBeGreaterThan(0)
    })

    it('returns empty for no match', async () => {
      const results = await searchMemories(db, { query: 'nonexistent_xyz_keyword' })
      expect(results.length).toBe(0)
    })
  })

  describe('getTopMemories (without query)', () => {
    it('returns top memories by score for project', () => {
      const results = getTopMemories(db, ['owt'], 10)
      expect(results.length).toBeGreaterThan(0)
      // Decisions should rank higher than bugs (weight 1.0 vs 0.7)
      const decisionIdx = results.findIndex(r => r.type === 'decision')
      const bugIdx = results.findIndex(r => r.type === 'bug')
      if (decisionIdx !== -1 && bugIdx !== -1) {
        expect(decisionIdx).toBeLessThan(bugIdx)
      }
    })

    it('includes global memories', () => {
      const results = getTopMemories(db, ['owt'], 10)
      const global = results.find(r => r.project === null)
      expect(global).toBeTruthy()
    })

    it('returns all projects when project is null', () => {
      const results = getTopMemories(db, null, 10)
      expect(results.length).toBe(5)
    })
  })

  describe('access tracking', () => {
    it('increments access_count on search', async () => {
      const before = await searchMemories(db, { query: 'inventory' })
      expect(before[0].accessCount).toBe(1) // incremented by this search

      const after = await searchMemories(db, { query: 'inventory' })
      expect(after[0].accessCount).toBe(2) // incremented again
    })
  })

  describe('reciprocalRankFusion', () => {
    it('merges results from both lists', () => {
      const ftsResults: Memory[] = [
        makeMemory({ id: 'a', content: 'FTS result A' }),
        makeMemory({ id: 'b', content: 'FTS result B' }),
      ]
      const vecResults = [
        { memory: makeMemory({ id: 'c', content: 'Vector result C' }), similarity: 0.95 },
        { memory: makeMemory({ id: 'd', content: 'Vector result D' }), similarity: 0.80 },
      ]

      const merged = reciprocalRankFusion(ftsResults, vecResults)
      expect(merged.length).toBe(4)
      // All 4 memories present
      const ids = merged.map(m => m.id)
      expect(ids).toContain('a')
      expect(ids).toContain('b')
      expect(ids).toContain('c')
      expect(ids).toContain('d')
    })

    it('deduplicates same memory appearing in both lists (higher score)', () => {
      const sharedMemory = makeMemory({ id: 'shared', content: 'Appears in both' })
      const ftsResults: Memory[] = [
        sharedMemory,
        makeMemory({ id: 'fts-only', content: 'FTS only' }),
      ]
      const vecResults = [
        { memory: { ...sharedMemory }, similarity: 0.9 },
        { memory: makeMemory({ id: 'vec-only', content: 'Vec only' }), similarity: 0.7 },
      ]

      const merged = reciprocalRankFusion(ftsResults, vecResults)
      // Should have 3 unique memories, not 4
      expect(merged.length).toBe(3)
      const ids = merged.map(m => m.id)
      expect(ids).toContain('shared')
      expect(ids).toContain('fts-only')
      expect(ids).toContain('vec-only')

      // 'shared' should rank first because it has RRF score from BOTH lists
      expect(merged[0].id).toBe('shared')
    })

    it('handles empty FTS5 list', () => {
      const vecResults = [
        { memory: makeMemory({ id: 'v1', content: 'Vector 1' }), similarity: 0.95 },
        { memory: makeMemory({ id: 'v2', content: 'Vector 2' }), similarity: 0.80 },
      ]

      const merged = reciprocalRankFusion([], vecResults)
      expect(merged.length).toBe(2)
      expect(merged[0].id).toBe('v1')
      expect(merged[1].id).toBe('v2')
    })

    it('handles empty vector list', () => {
      const ftsResults: Memory[] = [
        makeMemory({ id: 'f1', content: 'FTS 1' }),
        makeMemory({ id: 'f2', content: 'FTS 2' }),
      ]

      const merged = reciprocalRankFusion(ftsResults, [])
      expect(merged.length).toBe(2)
      expect(merged[0].id).toBe('f1')
      expect(merged[1].id).toBe('f2')
    })

    it('preserves rank order within single source', () => {
      const ftsResults: Memory[] = [
        makeMemory({ id: 'rank1', content: 'Rank 1' }),
        makeMemory({ id: 'rank2', content: 'Rank 2' }),
        makeMemory({ id: 'rank3', content: 'Rank 3' }),
      ]

      const merged = reciprocalRankFusion(ftsResults, [])
      expect(merged[0].id).toBe('rank1')
      expect(merged[1].id).toBe('rank2')
      expect(merged[2].id).toBe('rank3')
    })
  })
})
