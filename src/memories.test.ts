import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabase, closeDatabase } from './db.js'
import { createMemory, getMemory, updateMemory, expireMemory, getStats } from './memories.js'
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import os from 'os'

const TEST_DB_DIR = path.join(os.tmpdir(), 'memrecall-mem-test-' + Date.now())
const TEST_DB_PATH = path.join(TEST_DB_DIR, 'memrecall.db')

describe('memories', () => {
  let db: Database.Database

  beforeEach(() => {
    fs.mkdirSync(TEST_DB_DIR, { recursive: true })
    db = createDatabase(TEST_DB_PATH)
  })

  afterEach(() => {
    closeDatabase(db)
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true })
  })

  describe('createMemory', () => {
    it('creates a memory with auto-assigned weight', () => {
      const mem = createMemory(db, { type: 'decision', content: 'Use SQLite for storage' })
      expect(mem.id).toBeTruthy()
      expect(mem.type).toBe('decision')
      expect(mem.weight).toBe(1.0)
      expect(mem.validUntil).toBeNull()
    })

    it('normalizes project name', () => {
      const mem = createMemory(db, { type: 'context', content: 'Test', project: 'OWT Platform' })
      expect(mem.project).toBe('owt-platform')
    })

    it('rejects empty content', () => {
      expect(() => createMemory(db, { type: 'decision', content: '   ' })).toThrow('Content cannot be empty')
    })

    it('rejects content over 2000 chars', () => {
      expect(() => createMemory(db, { type: 'decision', content: 'x'.repeat(2001) })).toThrow('Content exceeds 2000 character limit')
    })

    it('syncs to FTS5 index', () => {
      createMemory(db, { type: 'decision', content: 'Use SQLite for persistent storage', tags: ['architecture'] })
      const ftsResult = db.prepare("SELECT * FROM memories_fts WHERE memories_fts MATCH 'SQLite'").all()
      expect(ftsResult.length).toBe(1)
    })

    it('stores tags as JSON in memories table', () => {
      const mem = createMemory(db, { type: 'bug', content: 'Test', tags: ['prisma', 'migration'] })
      const row = db.prepare('SELECT tags FROM memories WHERE id = ?').get(mem.id) as any
      expect(JSON.parse(row.tags)).toEqual(['prisma', 'migration'])
    })
  })

  describe('getMemory', () => {
    it('returns memory by id', () => {
      const created = createMemory(db, { type: 'feedback', content: 'Never use disabled buttons' })
      const found = getMemory(db, created.id)
      expect(found).toBeTruthy()
      expect(found!.content).toBe('Never use disabled buttons')
    })

    it('returns null for non-existent id', () => {
      expect(getMemory(db, 'nonexistent')).toBeNull()
    })
  })

  describe('updateMemory', () => {
    it('updates content and syncs FTS5', () => {
      const mem = createMemory(db, { type: 'decision', content: 'Use PostgreSQL' })
      updateMemory(db, { id: mem.id, content: 'Use SQLite instead of PostgreSQL' })

      const updated = getMemory(db, mem.id)
      expect(updated!.content).toBe('Use SQLite instead of PostgreSQL')

      // New content should match
      const newMatch = db.prepare("SELECT * FROM memories_fts WHERE memories_fts MATCH 'SQLite'").all()
      expect(newMatch.length).toBe(1)
      // Updated content contains both words
      expect(newMatch[0].content).toContain('SQLite')
    })

    it('throws on non-existent id', () => {
      expect(() => updateMemory(db, { id: 'nonexistent', content: 'test' })).toThrow()
    })
  })

  describe('expireMemory', () => {
    it('sets valid_until and removes from FTS5', () => {
      const mem = createMemory(db, { type: 'decision', content: 'Use Redis for caching' })
      expireMemory(db, mem.id)

      const expired = getMemory(db, mem.id)
      expect(expired!.validUntil).toBeTruthy()

      // Should not appear in FTS5 search
      const ftsResult = db.prepare("SELECT * FROM memories_fts WHERE memories_fts MATCH 'Redis'").all()
      expect(ftsResult.length).toBe(0)
    })
  })

  describe('getStats', () => {
    it('returns correct counts', () => {
      createMemory(db, { type: 'decision', content: 'Test 1', project: 'owt' })
      createMemory(db, { type: 'feedback', content: 'Test 2', project: 'owt' })
      createMemory(db, { type: 'bug', content: 'Test 3' })
      const mem4 = createMemory(db, { type: 'context', content: 'Test 4', project: 'owt' })
      expireMemory(db, mem4.id)

      const stats = getStats(db)
      expect(stats.total).toBe(4)
      expect(stats.active).toBe(3)
      expect(stats.expired).toBe(1)
      expect(stats.byType.decision).toBe(1)
      expect(stats.byType.feedback).toBe(1)
      expect(stats.byProject.owt).toBe(3)
    })
  })
})
