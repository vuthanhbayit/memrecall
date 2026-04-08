import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import os from 'os'

const DEFAULT_DB_DIR = path.join(os.homedir(), '.memrecall')
const DEFAULT_DB_PATH = path.join(DEFAULT_DB_DIR, 'memrecall.db')

let verbose = false

export function setVerbose(v: boolean) {
  verbose = v
}

function log(...args: unknown[]) {
  if (verbose) console.error('[memrecall]', ...args)
}

export function getDefaultDbPath(): string {
  return DEFAULT_DB_PATH
}

export function createDatabase(dbPath: string = DEFAULT_DB_PATH): Database.Database {
  const dir = path.dirname(dbPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { mode: 0o700, recursive: true })
    log('Created directory:', dir)
  }

  const db = new Database(dbPath)

  // SQLite configuration
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  db.pragma('foreign_keys = ON')

  // Run migrations
  migrate(db)

  log('Database ready:', dbPath)
  return db
}

function migrate(db: Database.Database) {
  const version = db.pragma('user_version', { simple: true }) as number

  if (version < 1) {
    log('Running migration v0 → v1')
    db.exec(`
      CREATE TABLE memories (
        id               TEXT PRIMARY KEY,
        type             TEXT NOT NULL,
        content          TEXT NOT NULL,
        weight           REAL NOT NULL,
        project          TEXT,
        tags             TEXT,
        valid_from       TEXT NOT NULL,
        valid_until      TEXT,
        access_count     INTEGER NOT NULL DEFAULT 0,
        last_accessed_at TEXT,
        created_at       TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE memories_fts USING fts5(
        content,
        tags,
        content='memories',
        content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2'
      );

      CREATE INDEX idx_project_valid ON memories(project, valid_until) WHERE valid_until IS NULL;
      CREATE INDEX idx_created_at ON memories(created_at);
    `)
    db.pragma('user_version = 1')
  }
}

export function closeDatabase(db: Database.Database) {
  db.close()
}
