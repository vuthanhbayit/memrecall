import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabase, closeDatabase } from './db.js'
import { addTriple, queryTriples, invalidateTriple, getTimeline, searchTriplesByQuery } from './kg.js'
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import os from 'os'

const TEST_DB_DIR = path.join(os.tmpdir(), 'memrecall-kg-test-' + Date.now())
const TEST_DB_PATH = path.join(TEST_DB_DIR, 'memrecall.db')

describe('knowledge graph', () => {
  let db: Database.Database

  beforeEach(() => {
    fs.mkdirSync(TEST_DB_DIR, { recursive: true })
    db = createDatabase(TEST_DB_PATH)
  })

  afterEach(() => {
    closeDatabase(db)
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true })
  })

  describe('addTriple', () => {
    it('creates a triple and returns correct shape', () => {
      const triple = addTriple(db, { subject: 'OWT', predicate: 'uses', object: 'SQLite' })
      expect(triple.id).toBeTruthy()
      expect(triple.subject).toBe('OWT')
      expect(triple.predicate).toBe('uses')
      expect(triple.object).toBe('SQLite')
      expect(triple.validFrom).toBeTruthy()
      expect(triple.validUntil).toBeNull()
      expect(triple.createdAt).toBeTruthy()
    })

    it('deduplicates — same triple returns existing without creating duplicate', () => {
      const first = addTriple(db, { subject: 'OWT', predicate: 'uses', object: 'SQLite' })
      const second = addTriple(db, { subject: 'OWT', predicate: 'uses', object: 'SQLite' })
      expect(second.id).toBe(first.id)

      const count = db.prepare('SELECT COUNT(*) as c FROM triples').get() as { c: number }
      expect(count.c).toBe(1)
    })

    it('defaults valid_from to now', () => {
      const before = new Date().toISOString()
      const triple = addTriple(db, { subject: 'A', predicate: 'knows', object: 'B' })
      const after = new Date().toISOString()
      expect(triple.validFrom >= before).toBe(true)
      expect(triple.validFrom <= after).toBe(true)
    })

    it('normalizes predicate to lowercase', () => {
      const triple = addTriple(db, { subject: 'A', predicate: '  WORKS_AT  ', object: 'B' })
      expect(triple.predicate).toBe('works_at')
    })

    it('keeps subject and object original case', () => {
      const triple = addTriple(db, { subject: '  Alice  ', predicate: 'knows', object: '  Bob  ' })
      expect(triple.subject).toBe('Alice')
      expect(triple.object).toBe('Bob')
    })

    it('throws on empty subject', () => {
      expect(() => addTriple(db, { subject: '  ', predicate: 'uses', object: 'X' })).toThrow('subject cannot be empty')
    })

    it('throws on empty predicate', () => {
      expect(() => addTriple(db, { subject: 'A', predicate: '', object: 'X' })).toThrow('predicate cannot be empty')
    })

    it('throws on empty object', () => {
      expect(() => addTriple(db, { subject: 'A', predicate: 'uses', object: '   ' })).toThrow('object cannot be empty')
    })

    it('uses custom validFrom when provided', () => {
      const customDate = '2025-01-01T00:00:00.000Z'
      const triple = addTriple(db, { subject: 'A', predicate: 'knows', object: 'B', validFrom: customDate })
      expect(triple.validFrom).toBe(customDate)
    })

    it('stores project when provided', () => {
      const triple = addTriple(db, { subject: 'A', predicate: 'uses', object: 'B', project: 'owt' })
      expect(triple.project).toBe('owt')
    })
  })

  describe('queryTriples', () => {
    it('finds by subject', () => {
      addTriple(db, { subject: 'Alice', predicate: 'knows', object: 'Bob' })
      addTriple(db, { subject: 'Charlie', predicate: 'knows', object: 'Dave' })

      const results = queryTriples(db, { entity: 'Alice' })
      expect(results).toHaveLength(1)
      expect(results[0].subject).toBe('Alice')
    })

    it('finds by object', () => {
      addTriple(db, { subject: 'Alice', predicate: 'knows', object: 'Bob' })

      const results = queryTriples(db, { entity: 'Bob' })
      expect(results).toHaveLength(1)
      expect(results[0].object).toBe('Bob')
    })

    it('filters by predicate', () => {
      addTriple(db, { subject: 'Alice', predicate: 'knows', object: 'Bob' })
      addTriple(db, { subject: 'Alice', predicate: 'works_with', object: 'Charlie' })

      const results = queryTriples(db, { entity: 'Alice', predicate: 'knows' })
      expect(results).toHaveLength(1)
      expect(results[0].predicate).toBe('knows')
    })

    it('excludes expired by default', () => {
      addTriple(db, { subject: 'Alice', predicate: 'uses', object: 'PostgreSQL' })
      invalidateTriple(db, { subject: 'Alice', predicate: 'uses', object: 'PostgreSQL' })
      addTriple(db, { subject: 'Alice', predicate: 'uses', object: 'SQLite' })

      const results = queryTriples(db, { entity: 'Alice' })
      expect(results).toHaveLength(1)
      expect(results[0].object).toBe('SQLite')
    })

    it('includes expired when flag set', () => {
      addTriple(db, { subject: 'Alice', predicate: 'uses', object: 'PostgreSQL' })
      invalidateTriple(db, { subject: 'Alice', predicate: 'uses', object: 'PostgreSQL' })
      addTriple(db, { subject: 'Alice', predicate: 'uses', object: 'SQLite' })

      const results = queryTriples(db, { entity: 'Alice', includeExpired: true })
      expect(results).toHaveLength(2)
    })

    it('filters by project', () => {
      addTriple(db, { subject: 'Alice', predicate: 'uses', object: 'SQLite', project: 'owt' })
      addTriple(db, { subject: 'Alice', predicate: 'uses', object: 'Redis', project: 'other' })

      const results = queryTriples(db, { entity: 'Alice', project: 'owt' })
      expect(results).toHaveLength(1)
      expect(results[0].object).toBe('SQLite')
    })

    it('returns results ordered by valid_from DESC', () => {
      addTriple(db, { subject: 'Alice', predicate: 'knows', object: 'Bob', validFrom: '2025-01-01T00:00:00.000Z' })
      addTriple(db, { subject: 'Alice', predicate: 'knows', object: 'Charlie', validFrom: '2025-06-01T00:00:00.000Z' })

      const results = queryTriples(db, { entity: 'Alice' })
      expect(results[0].object).toBe('Charlie')
      expect(results[1].object).toBe('Bob')
    })
  })

  describe('invalidateTriple', () => {
    it('sets valid_until and returns true', () => {
      addTriple(db, { subject: 'Alice', predicate: 'uses', object: 'PostgreSQL' })

      const result = invalidateTriple(db, { subject: 'Alice', predicate: 'uses', object: 'PostgreSQL' })
      expect(result).toBe(true)

      const row = db.prepare('SELECT * FROM triples WHERE subject = ?').get('Alice') as any
      expect(row.valid_until).toBeTruthy()
    })

    it('returns false when no match', () => {
      const result = invalidateTriple(db, { subject: 'Nobody', predicate: 'uses', object: 'Nothing' })
      expect(result).toBe(false)
    })

    it('does not invalidate already-expired triples', () => {
      addTriple(db, { subject: 'Alice', predicate: 'uses', object: 'PostgreSQL' })
      invalidateTriple(db, { subject: 'Alice', predicate: 'uses', object: 'PostgreSQL' })

      // Second invalidation should return false (already expired)
      const result = invalidateTriple(db, { subject: 'Alice', predicate: 'uses', object: 'PostgreSQL' })
      expect(result).toBe(false)
    })
  })

  describe('getTimeline', () => {
    it('returns chronological order including expired', () => {
      addTriple(db, { subject: 'OWT', predicate: 'uses', object: 'PostgreSQL', validFrom: '2025-01-01T00:00:00.000Z' })
      invalidateTriple(db, { subject: 'OWT', predicate: 'uses', object: 'PostgreSQL' })
      addTriple(db, { subject: 'OWT', predicate: 'uses', object: 'SQLite', validFrom: '2025-06-01T00:00:00.000Z' })

      const timeline = getTimeline(db, 'OWT')
      expect(timeline).toHaveLength(2)
      // Chronological ASC — oldest first
      expect(timeline[0].object).toBe('PostgreSQL')
      expect(timeline[0].validUntil).toBeTruthy()
      expect(timeline[1].object).toBe('SQLite')
      expect(timeline[1].validUntil).toBeNull()
    })

    it('filters by project', () => {
      addTriple(db, { subject: 'OWT', predicate: 'uses', object: 'SQLite', project: 'owt' })
      addTriple(db, { subject: 'OWT', predicate: 'uses', object: 'Redis', project: 'other' })

      const timeline = getTimeline(db, 'OWT', 'owt')
      expect(timeline).toHaveLength(1)
      expect(timeline[0].object).toBe('SQLite')
    })
  })

  describe('searchTriplesByQuery', () => {
    it('finds by partial subject match', () => {
      addTriple(db, { subject: 'OWT Platform', predicate: 'uses', object: 'SQLite' })

      const results = searchTriplesByQuery(db, 'Platform')
      expect(results).toHaveLength(1)
      expect(results[0].subject).toBe('OWT Platform')
    })

    it('finds by partial object match', () => {
      addTriple(db, { subject: 'OWT', predicate: 'uses', object: 'better-sqlite3' })

      const results = searchTriplesByQuery(db, 'sqlite')
      expect(results).toHaveLength(1)
      expect(results[0].object).toBe('better-sqlite3')
    })

    it('case-insensitive search', () => {
      addTriple(db, { subject: 'Alice', predicate: 'knows', object: 'Bob' })

      const results = searchTriplesByQuery(db, 'alice')
      expect(results).toHaveLength(1)
      expect(results[0].subject).toBe('Alice')
    })

    it('only returns active triples', () => {
      addTriple(db, { subject: 'Alice', predicate: 'uses', object: 'PostgreSQL' })
      invalidateTriple(db, { subject: 'Alice', predicate: 'uses', object: 'PostgreSQL' })

      const results = searchTriplesByQuery(db, 'Alice')
      expect(results).toHaveLength(0)
    })

    it('filters by projects', () => {
      addTriple(db, { subject: 'Alice', predicate: 'uses', object: 'SQLite', project: 'owt' })
      addTriple(db, { subject: 'Alice', predicate: 'uses', object: 'Redis', project: 'other' })

      const results = searchTriplesByQuery(db, 'Alice', ['owt'])
      expect(results).toHaveLength(1)
      expect(results[0].object).toBe('SQLite')
    })

    it('respects limit of 10', () => {
      for (let i = 0; i < 15; i++) {
        addTriple(db, { subject: `Entity${i}`, predicate: 'knows', object: 'Target' })
      }

      const results = searchTriplesByQuery(db, 'Target')
      expect(results).toHaveLength(10)
    })
  })
})
