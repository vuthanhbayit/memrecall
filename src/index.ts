import { Command } from 'commander'
import { createDatabase, closeDatabase, getDefaultDbPath, setVerbose } from './db.js'
import { getMemory, getStats, exportMemories, importMemories, gcExpiredMemories } from './memories.js'
import { searchMemories, getTopMemories } from './search.js'
import { queryTriples, getTimeline } from './kg.js'
import type { TripleRow } from './types.js'
import { startServer } from './server.js'
import fs from 'fs'
import path from 'path'

const program = new Command()

program
  .name('memrecall')
  .description('Long-term memory for AI assistants')
  .version('0.2.2')
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
  .action(async (query, opts) => {
    if (program.opts().verbose) setVerbose(true)
    const db = createDatabase()
    try {
      const projects = opts.projects ? opts.projects.split(',') : opts.project ? [opts.project] : undefined
      const results = await searchMemories(db, { query, projects, type: opts.type, limit: parseInt(opts.limit, 10) })

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

      // Embedding coverage
      const embeddedCount = db.prepare(
        'SELECT COUNT(*) as count FROM memories WHERE valid_until IS NULL AND embedding IS NOT NULL'
          + (opts.project ? ' AND project = ?' : '')
      ).get(...(opts.project ? [opts.project] : [])) as { count: number }
      const pct = stats.active > 0 ? Math.round(embeddedCount.count / stats.active * 100) : 0
      console.log(`\nEmbeddings: ${embeddedCount.count}/${stats.active} (${pct}%)`)
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
      const results = getTopMemories(db, opts.project ? [opts.project] : null, parseInt(opts.limit, 10))
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
      const memories = exportMemories(db, opts.project)
      const json = JSON.stringify(memories, null, 2)

      if (opts.output) {
        fs.writeFileSync(opts.output, json)
        console.error(`Exported ${memories.length} memories to ${opts.output}`)
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

      const result = importMemories(db, rows)
      console.log(`Imported ${result.imported} memories (${result.skipped} skipped)`)
      if (result.errors.length > 0) {
        console.error('Validation errors:')
        for (const err of result.errors) console.error(`  - ${err}`)
      }
    } finally {
      closeDatabase(db)
    }
  })

// memrecall backup
program
  .command('backup')
  .description('Create a backup of the database')
  .option('-o, --output <file>', 'Backup file path')
  .action(async (opts) => {
    const dbPath = getDefaultDbPath()
    if (!fs.existsSync(dbPath)) {
      console.error('No database found at', dbPath)
      process.exit(1)
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupPath = opts.output || path.join(path.dirname(dbPath), `memrecall-backup-${timestamp}.db`)

    const db = createDatabase()
    try {
      await db.backup(backupPath)
      console.log(`Backup created: ${backupPath}`)
    } catch (e) {
      console.error('Backup failed:', e instanceof Error ? e.message : e)
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
      if (opts.dryRun) {
        let sql = 'SELECT COUNT(*) as count FROM memories WHERE valid_until IS NOT NULL'
        const params: any[] = []
        if (opts.before) { sql += ' AND valid_until < ?'; params.push(opts.before) }
        const { count } = db.prepare(sql).get(...params) as any
        console.log(`Would remove ${count} expired memories`)
        return
      }

      const result = gcExpiredMemories(db, opts.before)
      console.log(`Removed ${result.removed} expired memories`)
    } finally {
      closeDatabase(db)
    }
  })

// memrecall embed
program
  .command('embed')
  .description('Manage embeddings for semantic search')
  .option('-p, --project <project>', 'Filter by project')
  .option('--force', 'Re-embed all memories (even those with embeddings)')
  .option('--status', 'Show embedding coverage statistics')
  .action(async (opts) => {
    if (program.opts().verbose) setVerbose(true)
    const db = createDatabase()
    try {
      if (opts.status) {
        const params: unknown[] = []
        const projectFilter = opts.project ? ' AND project = ?' : ''
        if (opts.project) params.push(opts.project)

        const total = db.prepare(
          'SELECT COUNT(*) as count FROM memories WHERE valid_until IS NULL' + projectFilter
        ).get(...params) as { count: number }
        const embedded = db.prepare(
          'SELECT COUNT(*) as count FROM memories WHERE valid_until IS NULL AND embedding IS NOT NULL' + projectFilter
        ).get(...params) as { count: number }

        console.log(`Embedding coverage: ${embedded.count}/${total.count} memories`)
        console.log(`  Embedded: ${embedded.count}`)
        console.log(`  Missing: ${total.count - embedded.count}`)
        if (total.count > 0) {
          console.log(`  Coverage: ${Math.round(embedded.count / total.count * 100)}%`)
        }

        const { getProvider } = await import('./embed.js')
        const provider = await getProvider()
        console.log(`\nProvider: ${provider ? provider.name : 'none (install @huggingface/transformers or run Ollama)'}`)
        return
      }

      // Backfill mode
      const { getProvider, embeddingToBuffer } = await import('./embed.js')
      const provider = await getProvider()
      if (!provider) {
        console.error('No embedding provider available.')
        console.error('Install @huggingface/transformers or start Ollama (localhost:11434)')
        process.exit(1)
      }

      console.log(`Using provider: ${provider.name}`)

      let sql = 'SELECT id, content FROM memories WHERE valid_until IS NULL'
      const params: unknown[] = []
      if (!opts.force) {
        sql += ' AND embedding IS NULL'
      }
      if (opts.project) {
        sql += ' AND project = ?'
        params.push(opts.project)
      }
      sql += ' ORDER BY created_at ASC'

      const memories = db.prepare(sql).all(...params) as { id: string; content: string }[]

      if (memories.length === 0) {
        console.log('All memories already have embeddings.')
        return
      }

      console.log(`Embedding ${memories.length} memories...`)

      let done = 0
      let errors = 0
      for (const mem of memories) {
        try {
          const embedding = await provider.embed(mem.content)
          db.prepare('UPDATE memories SET embedding = ? WHERE id = ?')
            .run(embeddingToBuffer(embedding), mem.id)
          done++
          if (done % 10 === 0) {
            process.stdout.write(`\r  ${done}/${memories.length}`)
          }
        } catch (err) {
          errors++
          console.error(`\n  Failed: ${mem.id} — ${err instanceof Error ? err.message : err}`)
        }
      }

      if (done >= 10) process.stdout.write('\n')
      console.log(`Done: ${done} embedded, ${errors} errors`)
    } finally {
      closeDatabase(db)
    }
  })

// memrecall mine <path>
program
  .command('mine <path>')
  .description('Mine conversation history to extract memories')
  .option('-p, --project <project>', 'Tag mined memories with this project')
  .option('--format <format>', 'Force parser format (claude-code)')
  .option('--extract', 'Smart extraction (decisions, feedback, bugs)')
  .option('--dry-run', 'Preview without saving')
  .action(async (targetPath, opts) => {
    if (program.opts().verbose) setVerbose(true)
    const db = createDatabase()
    try {
      const { mine } = await import('./mining/index.js')
      const result = await mine(db, targetPath, {
        project: opts.project,
        format: opts.format,
        extract: opts.extract || false,
        dryRun: opts.dryRun || false,
      })

      console.log(`Conversations parsed: ${result.parsed}`)
      console.log(`Memories extracted:   ${result.extracted}`)
      console.log(`Memories saved:       ${result.saved}`)
      console.log(`Duplicates skipped:   ${result.skipped}`)
      if (opts.dryRun) console.log('\n(dry run — nothing saved)')
    } catch (e) {
      console.error('Mining failed:', e instanceof Error ? e.message : e)
      process.exit(1)
    } finally {
      closeDatabase(db)
    }
  })

// --- Knowledge Graph commands ---

const kg = program
  .command('kg')
  .description('Knowledge graph commands')

// memrecall kg query <entity>
kg
  .command('query <entity>')
  .description('Query facts about an entity')
  .option('--predicate <predicate>', 'Filter by relationship type')
  .option('-p, --project <project>', 'Filter by project')
  .option('--include-expired', 'Include expired facts')
  .action((entity, opts) => {
    if (program.opts().verbose) setVerbose(true)
    const db = createDatabase()
    try {
      const triples = queryTriples(db, {
        entity,
        predicate: opts.predicate,
        project: opts.project,
        includeExpired: opts.includeExpired || false,
      })

      if (triples.length === 0) {
        console.log('No facts found.')
        return
      }

      for (const t of triples) {
        const since = t.validFrom.slice(0, 10)
        let line = `${t.subject} → ${t.predicate} → ${t.object} (since ${since})`
        if (t.validUntil) {
          line += ` (ended ${t.validUntil.slice(0, 10)})`
        }
        console.log(line)
      }
    } finally {
      closeDatabase(db)
    }
  })

// memrecall kg timeline <entity>
kg
  .command('timeline <entity>')
  .description('Show chronological history of an entity')
  .option('-p, --project <project>', 'Filter by project')
  .action((entity, opts) => {
    if (program.opts().verbose) setVerbose(true)
    const db = createDatabase()
    try {
      const triples = getTimeline(db, entity, opts.project)

      if (triples.length === 0) {
        console.log('No facts found.')
        return
      }

      for (const t of triples) {
        const since = t.validFrom.slice(0, 10)
        let line = `${since}  ${t.subject} → ${t.predicate} → ${t.object}`
        if (t.validUntil) {
          line += ` (ended ${t.validUntil.slice(0, 10)})`
        }
        console.log(line)
      }
    } finally {
      closeDatabase(db)
    }
  })

// memrecall kg list
kg
  .command('list')
  .description('List all active triples')
  .option('-p, --project <project>', 'Filter by project')
  .option('-l, --limit <limit>', 'Max results', '50')
  .action((opts) => {
    if (program.opts().verbose) setVerbose(true)
    const db = createDatabase()
    try {
      const limit = parseInt(opts.limit, 10)
      const params: unknown[] = []
      let sql = 'SELECT * FROM triples WHERE valid_until IS NULL'

      if (opts.project) {
        sql += ' AND project = ?'
        params.push(opts.project)
      }

      sql += ' ORDER BY created_at DESC LIMIT ?'
      params.push(limit)

      const rows = db.prepare(sql).all(...params) as TripleRow[]

      if (rows.length === 0) {
        console.log('No triples found.')
        return
      }

      for (const row of rows) {
        const since = row.valid_from.slice(0, 10)
        const proj = row.project ? ` (${row.project})` : ''
        console.log(`${row.subject} → ${row.predicate} → ${row.object}${proj} (since ${since})`)
      }

      console.log(`\n${rows.length} triple(s)`)
    } finally {
      closeDatabase(db)
    }
  })

program.parseAsync()
