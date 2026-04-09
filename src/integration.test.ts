import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabase, closeDatabase } from './db.js'
import { createMemory, createMemoryWithEmbedding, expireMemory } from './memories.js'
import { searchMemories, getTopMemories, enhancedRecall } from './search.js'
import { addTriple } from './kg.js'
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import os from 'os'

const TEST_DB_DIR = path.join(os.tmpdir(), 'memrecall-integration-' + Date.now())
const TEST_DB_PATH = path.join(TEST_DB_DIR, 'memrecall.db')

describe('integration: full workflow', () => {
  let db: Database.Database

  beforeEach(() => {
    fs.mkdirSync(TEST_DB_DIR, { recursive: true })
    db = createDatabase(TEST_DB_PATH)
  })

  afterEach(() => {
    closeDatabase(db)
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true })
  })

  it('simulates real usage: remember → search → update → forget → search', async () => {
    // 1. AI auto-remembers during conversations
    const m1 = createMemory(db, {
      type: 'decision',
      content: 'Use per-variant inventory tracking instead of per-product. More flexible than Odoo.',
      project: 'owt',
      tags: ['inventory', 'architecture'],
    })

    createMemory(db, {
      type: 'feedback',
      content: 'Never use disabled buttons. Always allow click and show validation error.',
      project: 'owt',
    })

    createMemory(db, {
      type: 'bug',
      content: 'After schema change: must run prisma generate + restart dev server or types are stale.',
      project: 'owt',
      tags: ['prisma'],
    })

    createMemory(db, {
      type: 'feedback',
      content: 'User prefers terse responses. No trailing summaries.',
    }) // global

    // 2. New conversation starts — AI loads top memories
    const top = getTopMemories(db, ['owt'], 10)
    expect(top.length).toBe(4) // 3 owt + 1 global
    // Decision should be first (weight 1.0)
    expect(top[0].type).toBe('decision')

    // 3. AI searches for specific topic
    const inventoryResults = await searchMemories(db, { query: 'inventory', projects: ['owt'] })
    expect(inventoryResults.length).toBeGreaterThan(0)
    expect(inventoryResults[0].content).toContain('per-variant')

    // 4. Decision changes — forget old, remember new
    expireMemory(db, m1.id)
    createMemory(db, {
      type: 'decision',
      content: 'Switched to per-product inventory tracking for simplicity. Variant-level was overkill.',
      project: 'owt',
      tags: ['inventory', 'architecture'],
    })

    // 5. Search should only find new decision
    const afterChange = await searchMemories(db, { query: 'inventory tracking', projects: ['owt'] })
    expect(afterChange.length).toBe(1)
    expect(afterChange[0].content).toContain('per-product')

    // 6. Cross-project search
    createMemory(db, {
      type: 'decision',
      content: 'API returns price including VAT for all endpoints.',
      project: 'thinkpro-api',
    })

    const crossProject = await searchMemories(db, { query: 'VAT', projects: ['owt', 'thinkpro-api'] })
    expect(crossProject.length).toBe(1)
    expect(crossProject[0].project).toBe('thinkpro-api')
  })

  it('createMemoryWithEmbedding saves memory even without embedding provider', async () => {
    const mem = await createMemoryWithEmbedding(db, {
      type: 'decision',
      content: 'Use SQLite for storage because it is simple and fast.',
      project: 'test',
    })

    expect(mem.id).toBeDefined()
    expect(mem.content).toContain('SQLite')

    // Memory saved, but no embedding (no provider in test env)
    const row = db.prepare('SELECT embedding FROM memories WHERE id = ?').get(mem.id) as { embedding: Buffer | null }
    expect(row.embedding).toBeNull()
  })

  it('enhancedRecall returns memories + matching KG triples', async () => {
    createMemory(db, {
      type: 'decision',
      content: 'OWT uses PostgreSQL for the main database.',
      project: 'owt',
    })
    addTriple(db, { subject: 'OWT', predicate: 'uses', object: 'PostgreSQL', project: 'owt' })
    addTriple(db, { subject: 'OWT', predicate: 'uses', object: 'Nuxt 4', project: 'owt' })

    const result = await enhancedRecall(db, { query: 'OWT', projects: ['owt'] })

    expect(result.memories.length).toBeGreaterThan(0)
    expect(result.triples).not.toBeNull()
    expect(result.triples!.length).toBe(2)
    expect(result.triples!.map(t => t.object)).toContain('PostgreSQL')
    expect(result.triples!.map(t => t.object)).toContain('Nuxt 4')
  })

  it('enhancedRecall returns null triples when no KG match', async () => {
    createMemory(db, {
      type: 'context',
      content: 'Random context about something unrelated.',
      project: 'test',
    })

    const result = await enhancedRecall(db, { query: 'random', projects: ['test'] })

    expect(result.memories.length).toBeGreaterThan(0)
    expect(result.triples).toBeNull()
  })

  it('access tracking boosts frequently recalled memories', async () => {
    createMemory(db, { type: 'decision', content: 'Important decision about databases', project: 'test' })
    createMemory(db, { type: 'decision', content: 'Important decision about caching', project: 'test' })

    // Search "databases" 5 times to boost its access count
    for (let i = 0; i < 5; i++) {
      await searchMemories(db, { query: 'databases', projects: ['test'] })
    }

    // Now get top memories — "databases" should rank higher despite same weight/age
    const top = getTopMemories(db, ['test'], 2)
    expect(top[0].content).toContain('databases')
    expect(top[0].accessCount).toBe(6) // 5 searches + 1 from getTopMemories
  })
})
