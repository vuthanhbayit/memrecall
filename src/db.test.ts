import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabase, closeDatabase } from './db.js'
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import os from 'os'

const TEST_DB_DIR = path.join(os.tmpdir(), 'memrecall-test-' + Date.now())
const TEST_DB_PATH = path.join(TEST_DB_DIR, 'memrecall.db')

describe('database', () => {
  let db: Database.Database

  beforeEach(() => {
    fs.mkdirSync(TEST_DB_DIR, { recursive: true })
    db = createDatabase(TEST_DB_PATH)
  })

  afterEach(() => {
    closeDatabase(db)
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true })
  })

  it('creates memories table', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories'").get()
    expect(tables).toBeTruthy()
  })

  it('creates memories_fts virtual table', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'").get()
    expect(tables).toBeTruthy()
  })

  it('enables WAL mode', () => {
    const mode = db.pragma('journal_mode', { simple: true })
    expect(mode).toBe('wal')
  })

  it('sets busy timeout', () => {
    const timeout = db.pragma('busy_timeout', { simple: true })
    expect(timeout).toBe(5000)
  })

  it('sets user_version to 1', () => {
    const version = db.pragma('user_version', { simple: true })
    expect(version).toBe(1)
  })

  it('creates indexes', () => {
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'").all()
    const names = indexes.map((i: any) => i.name)
    expect(names).toContain('idx_project_valid')
    expect(names).toContain('idx_created_at')
  })

  it('skips migration if already at current version', () => {
    const db2 = createDatabase(TEST_DB_PATH)
    const version = db2.pragma('user_version', { simple: true })
    expect(version).toBe(1)
    closeDatabase(db2)
  })
})
