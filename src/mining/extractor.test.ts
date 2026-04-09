import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { extractMemories, wordOverlap } from './extractor.js'
import { mine } from './index.js'
import { createDatabase, closeDatabase } from '../db.js'
import { createMemory } from '../memories.js'
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import os from 'os'
import type { Conversation } from './types.js'

function makeConversation(messages: { role: 'user' | 'assistant'; content: string }[], source?: string): Conversation {
  return {
    id: 'test-conv',
    messages,
    metadata: { source: source || '/test/conversation.jsonl' },
  }
}

describe('extractor', () => {
  describe('raw mode', () => {
    it('returns 1 context memory per conversation', () => {
      const conv = makeConversation([
        { role: 'user', content: 'How should I structure the database?' },
        { role: 'assistant', content: 'I recommend using a relational schema with proper normalization.' },
      ])

      const results = extractMemories(conv, false)
      expect(results).toHaveLength(1)
      expect(results[0].type).toBe('context')
      expect(results[0].tags).toEqual(['mined', 'claude-code'])
      expect(results[0].content).toContain('How should I structure the database?')
      expect(results[0].content).toContain('relational schema')
    })

    it('truncates to 2000 chars total', () => {
      const conv = makeConversation([
        { role: 'user', content: 'x'.repeat(1500) },
        { role: 'assistant', content: 'y'.repeat(1500) },
      ])

      const results = extractMemories(conv, false)
      expect(results).toHaveLength(1)
      expect(results[0].content.length).toBeLessThanOrEqual(2000)
      expect(results[0].content.endsWith('...')).toBe(true)
    })

    it('returns empty array for conversation with no messages', () => {
      const conv = makeConversation([])
      const results = extractMemories(conv, false)
      expect(results).toHaveLength(0)
    })

    it('uses source from metadata', () => {
      const conv = makeConversation(
        [{ role: 'user', content: 'Hello' }],
        '/home/user/.claude/projects/myproject/conversations/abc.jsonl',
      )

      const results = extractMemories(conv, false)
      expect(results[0].source).toBe('/home/user/.claude/projects/myproject/conversations/abc.jsonl')
    })
  })

  describe('smart extract mode', () => {
    it('detects "decided to use PostgreSQL" as decision', () => {
      const conv = makeConversation([
        { role: 'user', content: 'What database should we use?' },
        { role: 'assistant', content: 'We decided to use PostgreSQL for the main database because of JSONB support.' },
      ])

      const results = extractMemories(conv, true)
      expect(results.length).toBeGreaterThanOrEqual(1)

      const decision = results.find(r => r.type === 'decision')
      expect(decision).toBeTruthy()
      expect(decision!.content).toContain('PostgreSQL')
      expect(decision!.tags).toEqual(['mined', 'extracted'])
    })

    it('detects "don\'t use any" as feedback', () => {
      const conv = makeConversation([
        { role: 'user', content: "don't use any ORM that generates binary engines" },
      ])

      const results = extractMemories(conv, true)
      expect(results.length).toBeGreaterThanOrEqual(1)

      const feedback = results.find(r => r.type === 'feedback')
      expect(feedback).toBeTruthy()
      expect(feedback!.content).toContain('ORM')
    })

    it('detects "root cause was X" as bug', () => {
      const conv = makeConversation([
        { role: 'assistant', content: 'The root cause was a missing index on the orders table causing full table scans.' },
      ])

      const results = extractMemories(conv, true)
      expect(results.length).toBeGreaterThanOrEqual(1)

      const bug = results.find(r => r.type === 'bug')
      expect(bug).toBeTruthy()
      expect(bug!.content).toContain('missing index')
    })

    it('returns empty array when no patterns match', () => {
      const conv = makeConversation([
        { role: 'user', content: 'Hello, how are you?' },
        { role: 'assistant', content: 'I am fine, thank you.' },
      ])

      const results = extractMemories(conv, true)
      expect(results).toHaveLength(0)
    })

    it('detects Vietnamese patterns', () => {
      const convDecision = makeConversation([
        { role: 'user', content: 'Em quyết định dùng Drizzle ORM thay vì Prisma cho project mới.' },
      ])
      const decisions = extractMemories(convDecision, true)
      expect(decisions.length).toBeGreaterThanOrEqual(1)
      expect(decisions.some(r => r.type === 'decision')).toBe(true)

      const convFeedback = makeConversation([
        { role: 'user', content: 'Anh đừng bao giờ dùng CommonJS require trong project này, luôn dùng ES modules.' },
      ])
      const feedbacks = extractMemories(convFeedback, true)
      expect(feedbacks.length).toBeGreaterThanOrEqual(1)
      expect(feedbacks.some(r => r.type === 'feedback')).toBe(true)

      const convBug = makeConversation([
        { role: 'assistant', content: 'Nguyên nhân là do thiếu await trước async function nên Promise chưa resolve.' },
      ])
      const bugs = extractMemories(convBug, true)
      expect(bugs.length).toBeGreaterThanOrEqual(1)
      expect(bugs.some(r => r.type === 'bug')).toBe(true)
    })

    it('detects multiple patterns from different messages', () => {
      const conv = makeConversation([
        { role: 'user', content: "Let's use Redis for caching all API responses." },
        { role: 'assistant', content: 'The root cause was that the cache TTL was set too low at 5 seconds.' },
      ])

      const results = extractMemories(conv, true)
      expect(results.length).toBeGreaterThanOrEqual(2)

      const types = results.map(r => r.type)
      expect(types).toContain('decision')
      expect(types).toContain('bug')
    })
  })
})

describe('wordOverlap', () => {
  it('returns 1.0 for identical strings', () => {
    expect(wordOverlap('hello world', 'hello world')).toBe(1.0)
  })

  it('returns 0.0 for completely different strings', () => {
    expect(wordOverlap('hello world', 'foo bar baz')).toBe(0.0)
  })

  it('returns correct ratio for partial overlap', () => {
    // "hello world foo" has 3 words, "hello world bar" has 3 words
    // intersection = {hello, world} = 2
    // max(3, 3) = 3
    // overlap = 2/3
    const result = wordOverlap('hello world foo', 'hello world bar')
    expect(result).toBeCloseTo(2 / 3, 5)
  })

  it('is case insensitive', () => {
    expect(wordOverlap('Hello World', 'hello world')).toBe(1.0)
  })

  it('handles empty strings', () => {
    expect(wordOverlap('', '')).toBe(1.0)
    expect(wordOverlap('hello', '')).toBe(0.0)
    expect(wordOverlap('', 'hello')).toBe(0.0)
  })

  it('handles whitespace-only strings', () => {
    expect(wordOverlap('   ', '   ')).toBe(1.0)
    expect(wordOverlap('hello', '   ')).toBe(0.0)
  })
})

describe('mine orchestrator: dedup', () => {
  const TEST_DB_DIR = path.join(os.tmpdir(), 'memrecall-mining-test-' + Date.now())
  const TEST_DB_PATH = path.join(TEST_DB_DIR, 'memrecall.db')
  const FIXTURES_DIR = path.join(os.tmpdir(), 'memrecall-mining-fixtures-' + Date.now())

  let db: Database.Database

  beforeEach(() => {
    fs.mkdirSync(TEST_DB_DIR, { recursive: true })
    fs.mkdirSync(FIXTURES_DIR, { recursive: true })
    db = createDatabase(TEST_DB_PATH)
  })

  afterEach(() => {
    closeDatabase(db)
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true })
    fs.rmSync(FIXTURES_DIR, { recursive: true, force: true })
  })

  function writeFixtureJsonl(filename: string, lines: object[]): string {
    const filePath = path.join(FIXTURES_DIR, filename)
    const content = lines.map(l => JSON.stringify(l)).join('\n')
    fs.writeFileSync(filePath, content, 'utf-8')
    return filePath
  }

  it('skips memory when >70% overlap with existing', async () => {
    // Pre-populate DB with an existing memory that matches what raw mode would produce
    // Raw mode joins: user message + \n---\n + assistant message
    createMemory(db, {
      type: 'context',
      content: 'How should we handle database migrations in production?\n---\nUse expand-contract pattern for zero-downtime migrations.',
      project: 'test',
    })

    // Create a fixture JSONL with nearly identical content
    const filePath = writeFixtureJsonl('test-conv.jsonl', [
      { type: 'human', text: 'How should we handle database migrations in production?' },
      { type: 'assistant', text: 'Use expand-contract pattern for zero-downtime migrations.' },
    ])

    const result = await mine(db, filePath, { project: 'test' })

    expect(result.parsed).toBe(1)
    expect(result.extracted).toBe(1)
    expect(result.skipped).toBe(1)
    expect(result.saved).toBe(0)
  })

  it('saves memory when no significant overlap', async () => {
    // Pre-populate DB with unrelated memory
    createMemory(db, {
      type: 'context',
      content: 'Use Redis for caching all API responses with TTL of 300 seconds',
      project: 'test',
    })

    // Create a fixture JSONL with different content
    const filePath = writeFixtureJsonl('new-conv.jsonl', [
      { type: 'human', text: 'How should we handle authentication in the mobile application for our users?' },
      { type: 'assistant', text: 'Use JWT tokens with refresh token rotation for mobile auth.' },
    ])

    const result = await mine(db, filePath, { project: 'test' })

    expect(result.parsed).toBe(1)
    expect(result.extracted).toBe(1)
    expect(result.saved).toBe(1)
    expect(result.skipped).toBe(0)
  })

  it('supports dry run mode (no saves to DB)', async () => {
    const filePath = writeFixtureJsonl('dry-run.jsonl', [
      { type: 'human', text: 'Implement the checkout flow with Stripe payment integration.' },
      { type: 'assistant', text: 'I will create the checkout API endpoints.' },
    ])

    const result = await mine(db, filePath, { project: 'test', dryRun: true })

    expect(result.parsed).toBe(1)
    expect(result.extracted).toBe(1)
    expect(result.saved).toBe(1) // counted as "would save"
    expect(result.skipped).toBe(0)

    // Verify nothing was actually saved
    const row = db.prepare('SELECT COUNT(*) as count FROM memories').get() as { count: number }
    expect(row.count).toBe(0)
  })

  it('parses JSONL with content array format', async () => {
    const filePath = writeFixtureJsonl('content-array.jsonl', [
      { type: 'human', content: [{ type: 'text', text: 'What is the best approach for handling file uploads?' }] },
      { type: 'assistant', content: [{ type: 'text', text: 'Use presigned S3 URLs for direct upload from the client.' }] },
    ])

    const result = await mine(db, filePath, { project: 'test' })

    expect(result.parsed).toBe(1)
    expect(result.extracted).toBe(1)
    expect(result.saved).toBe(1)
  })

  it('skips tool_use and tool_result lines', async () => {
    const filePath = writeFixtureJsonl('tool-lines.jsonl', [
      { type: 'human', text: 'Read the file at /src/index.ts' },
      { type: 'tool_use', name: 'Read', input: { file_path: '/src/index.ts' } },
      { type: 'tool_result', content: 'file contents here' },
      { type: 'assistant', text: 'The file contains the main entry point for the server.' },
    ])

    const result = await mine(db, filePath, { project: 'test' })

    expect(result.parsed).toBe(1)
    expect(result.extracted).toBe(1)
    expect(result.saved).toBe(1)
  })

  it('uses smart extraction with --extract flag', async () => {
    const filePath = writeFixtureJsonl('smart-extract.jsonl', [
      { type: 'human', text: "Let's use Drizzle ORM for the database layer instead of Prisma" },
      { type: 'assistant', text: 'The root cause was that Prisma generates a heavy binary engine that slows cold starts.' },
    ])

    const result = await mine(db, filePath, { project: 'test', extract: true })

    expect(result.parsed).toBe(1)
    expect(result.extracted).toBeGreaterThanOrEqual(2) // at least 1 decision + 1 bug
    expect(result.saved).toBeGreaterThanOrEqual(2)
  })
})
