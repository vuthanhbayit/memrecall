import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabase, closeDatabase } from './db.js'
import { createMemory } from './memories.js'
import { searchMemories, getTopMemories } from './search.js'
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import os from 'os'

const TEST_DB_DIR = path.join(os.tmpdir(), 'memrecall-search-test-' + Date.now())
const TEST_DB_PATH = path.join(TEST_DB_DIR, 'memrecall.db')

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
    it('finds memories by keyword', () => {
      const results = searchMemories(db, { query: 'inventory' })
      expect(results.length).toBeGreaterThan(0)
      expect(results[0].content).toContain('inventory')
    })

    it('filters by project + includes globals', () => {
      const results = searchMemories(db, { query: 'buttons OR terse', projects: ['owt'] })
      // Should find 'disabled buttons' (owt) and 'terse responses' (global)
      expect(results.length).toBe(2)
    })

    it('filters by type', () => {
      const results = searchMemories(db, { query: 'inventory OR SQLite', type: 'decision' })
      expect(results.every(r => r.type === 'decision')).toBe(true)
    })

    it('respects limit', () => {
      const results = searchMemories(db, { query: 'use OR never', limit: 2 })
      expect(results.length).toBe(2)
    })

    it('finds by tag', () => {
      const results = searchMemories(db, { query: 'prisma' })
      expect(results.length).toBeGreaterThan(0)
    })

    it('returns empty for no match', () => {
      const results = searchMemories(db, { query: 'nonexistent_xyz_keyword' })
      expect(results.length).toBe(0)
    })
  })

  describe('getTopMemories (without query)', () => {
    it('returns top memories by score for project', () => {
      const results = getTopMemories(db, 'owt', 10)
      expect(results.length).toBeGreaterThan(0)
      // Decisions should rank higher than bugs (weight 1.0 vs 0.7)
      const decisionIdx = results.findIndex(r => r.type === 'decision')
      const bugIdx = results.findIndex(r => r.type === 'bug')
      if (decisionIdx !== -1 && bugIdx !== -1) {
        expect(decisionIdx).toBeLessThan(bugIdx)
      }
    })

    it('includes global memories', () => {
      const results = getTopMemories(db, 'owt', 10)
      const global = results.find(r => r.project === null)
      expect(global).toBeTruthy()
    })

    it('returns all projects when project is null', () => {
      const results = getTopMemories(db, null, 10)
      expect(results.length).toBe(5)
    })
  })

  describe('access tracking', () => {
    it('increments access_count on search', () => {
      const before = searchMemories(db, { query: 'inventory' })
      expect(before[0].accessCount).toBe(1) // incremented by this search

      const after = searchMemories(db, { query: 'inventory' })
      expect(after[0].accessCount).toBe(2) // incremented again
    })
  })
})
