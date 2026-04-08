import { Command } from 'commander'
import { createDatabase, closeDatabase, getDefaultDbPath, setVerbose } from './db.js'
import { getMemory, getStats } from './memories.js'
import { searchMemories, getTopMemories } from './search.js'
import { startServer } from './server.js'
import fs from 'fs'
import path from 'path'

const program = new Command()

program
  .name('memrecall')
  .description('Long-term memory for AI assistants')
  .version('0.1.0')
  .option('--verbose', 'Enable verbose logging')

// memrecall serve
program
  .command('serve')
  .description('Start MCP server (stdio transport)')
  .action(async () => {
    if (program.opts().verbose) setVerbose(true)
    await startServer()
  })

// memrecall search <query>
program
  .command('search <query>')
  .description('Search memories')
  .option('-p, --project <project>', 'Filter by project')
  .option('--projects <projects>', 'Filter by multiple projects (comma-separated)')
  .option('-t, --type <type>', 'Filter by type')
  .option('-l, --limit <limit>', 'Max results', '10')
  .action((query, opts) => {
    if (program.opts().verbose) setVerbose(true)
    const db = createDatabase()
    try {
      const projects = opts.projects ? opts.projects.split(',') : opts.project ? [opts.project] : undefined
      const results = searchMemories(db, { query, projects, type: opts.type, limit: parseInt(opts.limit) })

      if (results.length === 0) {
        console.log('No memories found.')
        return
      }

      for (const m of results) {
        console.log(`[${m.type}]${m.project ? ` (${m.project})` : ''} ${m.content}`)
        console.log(`  id: ${m.id} | created: ${m.createdAt} | accessed: ${m.accessCount}x`)
        console.log()
      }
    } finally {
      closeDatabase(db)
    }
  })

// memrecall status
program
  .command('status')
  .description('Memory statistics')
  .option('-p, --project <project>', 'Filter by project')
  .action((opts) => {
    if (program.opts().verbose) setVerbose(true)
    const db = createDatabase()
    try {
      const stats = getStats(db, opts.project)
      console.log(`Total: ${stats.total} (${stats.active} active, ${stats.expired} expired)`)
      console.log('\nBy type:')
      for (const [type, count] of Object.entries(stats.byType)) {
        if (count > 0) console.log(`  ${type}: ${count}`)
      }
      console.log('\nBy project:')
      for (const [project, count] of Object.entries(stats.byProject)) {
        console.log(`  ${project}: ${count}`)
      }
    } finally {
      closeDatabase(db)
    }
  })

// memrecall list
program
  .command('list')
  .description('List recent memories')
  .option('-p, --project <project>', 'Filter by project')
  .option('-l, --limit <limit>', 'Max results', '20')
  .action((opts) => {
    if (program.opts().verbose) setVerbose(true)
    const db = createDatabase()
    try {
      const results = getTopMemories(db, opts.project || null, parseInt(opts.limit))
      for (const m of results) {
        console.log(`[${m.type}]${m.project ? ` (${m.project})` : ''} ${m.content}`)
        console.log(`  id: ${m.id} | created: ${m.createdAt}`)
        console.log()
      }
    } finally {
      closeDatabase(db)
    }
  })

// memrecall get <id>
program
  .command('get <id>')
  .description('View a specific memory')
  .action((id) => {
    if (program.opts().verbose) setVerbose(true)
    const db = createDatabase()
    try {
      const mem = getMemory(db, id)
      if (!mem) {
        console.error(`Memory not found: ${id}`)
        process.exit(1)
      }
      console.log(JSON.stringify(mem, null, 2))
    } finally {
      closeDatabase(db)
    }
  })

// memrecall export
program
  .command('export')
  .description('Export memories to JSON')
  .option('-p, --project <project>', 'Filter by project')
  .option('-o, --output <file>', 'Output file (default: stdout)')
  .action((opts) => {
    if (program.opts().verbose) setVerbose(true)
    const db = createDatabase()
    try {
      let sql = 'SELECT * FROM memories'
      const params: any[] = []
      if (opts.project) {
        sql += ' WHERE project = ?'
        params.push(opts.project)
      }
      sql += ' ORDER BY created_at DESC'
      const rows = db.prepare(sql).all(...params)
      const json = JSON.stringify(rows, null, 2)

      if (opts.output) {
        fs.writeFileSync(opts.output, json)
        console.error(`Exported ${rows.length} memories to ${opts.output}`)
      } else {
        console.log(json)
      }
    } finally {
      closeDatabase(db)
    }
  })

// memrecall import
program
  .command('import <file>')
  .description('Import memories from JSON file')
  .option('--dry-run', 'Show what would be imported without importing')
  .action((file, opts) => {
    if (program.opts().verbose) setVerbose(true)
    const db = createDatabase()
    try {
      const raw = fs.readFileSync(file, 'utf-8')
      const rows = JSON.parse(raw) as any[]

      if (opts.dryRun) {
        console.log(`Would import ${rows.length} memories`)
        return
      }

      let imported = 0
      let skipped = 0
      for (const row of rows) {
        const exists = db.prepare('SELECT id FROM memories WHERE id = ?').get(row.id)
        if (exists) { skipped++; continue }

        db.prepare(`
          INSERT INTO memories (id, type, content, weight, project, tags, valid_from, valid_until, access_count, last_accessed_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(row.id, row.type, row.content, row.weight, row.project, row.tags, row.valid_from, row.valid_until, row.access_count || 0, row.last_accessed_at, row.created_at)

        // Sync FTS5 (only for active memories)
        if (!row.valid_until) {
          const inserted = db.prepare('SELECT rowid FROM memories WHERE id = ?').get(row.id) as any
          const tagsText = row.tags ? JSON.parse(row.tags).join(' ') : ''
          db.prepare('INSERT INTO memories_fts (rowid, content, tags) VALUES (?, ?, ?)').run(inserted.rowid, row.content, tagsText)
        }

        imported++
      }
      console.log(`Imported ${imported} memories (${skipped} skipped — already exist)`)
    } finally {
      closeDatabase(db)
    }
  })

// memrecall backup
program
  .command('backup')
  .description('Create a backup of the database')
  .option('-o, --output <file>', 'Backup file path')
  .action((opts) => {
    const dbPath = getDefaultDbPath()
    if (!fs.existsSync(dbPath)) {
      console.error('No database found at', dbPath)
      process.exit(1)
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupPath = opts.output || path.join(path.dirname(dbPath), `memrecall-backup-${timestamp}.db`)

    const db = createDatabase()
    try {
      db.backup(backupPath)
      console.log(`Backup created: ${backupPath}`)
    } catch {
      console.error('Backup failed')
      process.exit(1)
    } finally {
      closeDatabase(db)
    }
  })

// memrecall gc
program
  .command('gc')
  .description('Clean up expired memories')
  .option('--before <date>', 'Remove expired memories older than this date (ISO 8601)')
  .option('--dry-run', 'Show what would be removed without removing')
  .action((opts) => {
    if (program.opts().verbose) setVerbose(true)
    const db = createDatabase()
    try {
      let sql = 'SELECT COUNT(*) as count FROM memories WHERE valid_until IS NOT NULL'
      const params: any[] = []
      if (opts.before) {
        sql += ' AND valid_until < ?'
        params.push(opts.before)
      }
      const { count } = db.prepare(sql).get(...params) as any

      if (opts.dryRun) {
        console.log(`Would remove ${count} expired memories`)
        return
      }

      let deleteSql = 'DELETE FROM memories WHERE valid_until IS NOT NULL'
      if (opts.before) {
        deleteSql += ' AND valid_until < ?'
      }
      db.prepare(deleteSql).run(...params)
      console.log(`Removed ${count} expired memories`)
    } finally {
      closeDatabase(db)
    }
  })

program.parse()
