import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { createDatabase } from './db.js'
import { createMemoryWithEmbedding, updateMemory, expireMemory, getStats, errorResponse } from './memories.js'
import { enhancedRecall, getTopMemories } from './search.js'
import { mine } from './mining/index.js'
import { addTriple, queryTriples, invalidateTriple } from './kg.js'
import type { MemoryType } from './types.js'

export async function startServer() {
  const db = createDatabase()
  const defaultProject = process.env.MEMRECALL_PROJECT || null

  const server = new McpServer({
    name: 'memrecall',
    version: '0.2.2',
  })

  // Tool: memrecall_remember
  server.tool(
    'memrecall_remember',
    `Save important information from this conversation as a long-term memory.

CALL WHEN:
- Design decisions ("decided to use X", "going with approach Y over Z")
- User feedback or preferences ("don't do X", "always Y", "I prefer Z")
- Root cause of complex bugs ("failed because X", "the issue was Y")
- Business rules or constraints ("X is not allowed when Y")
- Important project context (architecture, conventions, deadlines)

DO NOT CALL WHEN:
- Fixing typos, renaming variables, small routine changes
- Answering simple syntax questions
- Performing routine operations with no new insights
- Information already saved (search first with memrecall_recall)

CONTENT QUALITY — write memories that your future self can understand WITHOUT context:
- BAD:  "decided to use Nitro" (18 chars — useless without context)
- GOOD: "Decided to use Nitro instead of Express for the API server. Reasons: native Nuxt integration, auto-imports, zero-config TypeScript. Trade-off: less middleware ecosystem but acceptable." (180 chars — self-contained)
- INCLUDE: what was decided/learned, WHY (reasoning), what alternatives were rejected, any trade-offs or constraints
- TARGET: 150-500 characters per memory. Short enough to scan, long enough to be useful.

BEFORE SAVING: Search existing memories for similar content with memrecall_recall.
If a similar memory exists, use memrecall_update instead of creating a duplicate.`,
    {
      type: z.enum(['decision', 'feedback', 'bug', 'context', 'reference']).describe('Memory type'),
      content: z.string().describe('Self-contained memory. Include: WHAT + WHY + alternatives/trade-offs. Target 150-500 chars.'),
      project: z.string().optional().describe('Project identifier (lowercase slug). Omit for global memories.'),
      tags: z.array(z.string()).optional().describe('Optional categorization tags.'),
    },
    async (params) => {
      try {
        const memory = await createMemoryWithEmbedding(db, {
          type: params.type as MemoryType,
          content: params.content,
          project: params.project !== undefined ? params.project : (defaultProject ?? undefined),
          tags: params.tags,
        })
        return { content: [{ type: 'text' as const, text: JSON.stringify({ saved: true, id: memory.id, type: memory.type, project: memory.project }) }] }
      } catch (e: unknown) {
        return errorResponse(e)
      }
    }
  )

  // Tool: memrecall_recall
  server.tool(
    'memrecall_recall',
    `Search long-term memories from previous conversations.

IMPORTANT: Call this tool at the START of every new conversation with no query to load your long-term memory. This is essential — without it, you have no memory of previous conversations.

ALSO CALL WHEN:
- Needing context about a topic being discussed
- User asks "what did we decide about X"
- Before making a decision (check if prior decision exists)
- User references previous work or conversations`,
    {
      query: z.string().optional().describe('FTS search query. Omit to get top memories by score.'),
      projects: z.array(z.string()).optional().describe('Filter by projects. Omit to use default project from MEMRECALL_PROJECT env.'),
      type: z.enum(['decision', 'feedback', 'bug', 'context', 'reference']).optional().describe('Filter by memory type.'),
      limit: z.number().optional().default(10).describe('Max results to return.'),
    },
    async (params) => {
      try {
        const projects = params.projects || (defaultProject ? [defaultProject] : undefined)

        if (!params.query) {
          const results = getTopMemories(db, projects ?? (defaultProject ? [defaultProject] : null), params.limit ?? 15, params.type as MemoryType | undefined)
          const formatted = results.map(m =>
            `[${m.type}]${m.project ? ` (${m.project})` : ''} ${m.content} {id:${m.id}}`
          ).join('\n')
          return { content: [{ type: 'text' as const, text: formatted || 'No memories found.' }] }
        }

        // Enhanced recall: hybrid search + KG triples
        const { memories, triples } = await enhancedRecall(db, {
          query: params.query, projects, type: params.type as MemoryType | undefined, limit: params.limit,
        })

        let text = memories.map(m =>
          `[${m.type}]${m.project ? ` (${m.project})` : ''} ${m.content} {id:${m.id}}`
        ).join('\n')

        if (triples && triples.length > 0) {
          text += '\n\n--- Knowledge Graph ---\n'
          text += triples.map(t => {
            let line = `${t.subject} → ${t.predicate} → ${t.object} (since ${t.validFrom.slice(0, 10)})`
            if (t.validUntil) line += ` (ended ${t.validUntil.slice(0, 10)})`
            return line
          }).join('\n')
        }

        return { content: [{ type: 'text' as const, text: text || 'No memories found.' }] }
      } catch (e: unknown) {
        return errorResponse(e)
      }
    }
  )

  // Tool: memrecall_update
  server.tool(
    'memrecall_update',
    `Update an existing memory's content. Use when information needs correction or additional context, but the memory is still about the same topic.

For replaced decisions (e.g., "we used to do X, now doing Y"):
use memrecall_forget on the old memory, then memrecall_remember for the new one.`,
    {
      id: z.string().describe('Memory ID to update.'),
      content: z.string().describe('Updated content.'),
    },
    async (params) => {
      try {
        const memory = updateMemory(db, { id: params.id, content: params.content })
        return { content: [{ type: 'text' as const, text: JSON.stringify({ updated: true, id: memory.id }) }] }
      } catch (e: unknown) {
        return errorResponse(e)
      }
    }
  )

  // Tool: memrecall_forget
  server.tool(
    'memrecall_forget',
    `Mark a memory as expired. Does not delete — sets valid_until timestamp. Expired memories no longer appear in search results.

CALL WHEN:
- User says "forget that", "that's no longer true"
- A decision has been reverted
- Information is confirmed outdated`,
    {
      id: z.string().describe('Memory ID to expire.'),
      reason: z.string().optional().describe('Why this memory is no longer valid.'),
    },
    async (params) => {
      try {
        expireMemory(db, params.id)
        return { content: [{ type: 'text' as const, text: JSON.stringify({ forgotten: true, id: params.id }) }] }
      } catch (e: unknown) {
        return errorResponse(e)
      }
    }
  )

  // Tool: memrecall_status
  server.tool(
    'memrecall_status',
    'Get overview of stored memories: total count, breakdown by project and type.',
    {
      project: z.string().optional().describe('Filter stats by project. Omit for all.'),
    },
    async (params) => {
      try {
        const stats = getStats(db, params.project)
        return { content: [{ type: 'text' as const, text: JSON.stringify(stats, null, 2) }] }
      } catch (e: unknown) {
        return errorResponse(e)
      }
    }
  )

  // Tool: memrecall_kg_add
  server.tool(
    'memrecall_kg_add',
    `Save a structured fact as a knowledge graph triple (subject → predicate → object).

CALL WHEN:
- Learning a concrete relationship ("X uses Y", "A works on B", "C depends on D")
- Technology choices, team assignments, project dependencies
- Facts that can be expressed as (subject, predicate, object)

DO NOT CALL WHEN:
- Opinions, preferences, rules → use memrecall_remember instead
- Vague context → use memrecall_remember instead`,
    {
      subject: z.string().describe('The entity (e.g., "OWT", "Bay")'),
      predicate: z.string().describe('The relationship (e.g., "uses", "works_on", "depends_on")'),
      object: z.string().describe('The related entity (e.g., "Prisma 7", "Nuxt 4")'),
      project: z.string().optional().describe('Project scope. Omit for global facts.'),
    },
    async (params) => {
      try {
        const triple = addTriple(db, {
          subject: params.subject,
          predicate: params.predicate,
          object: params.object,
          project: params.project || defaultProject || undefined,
        })
        return { content: [{ type: 'text' as const, text: JSON.stringify({ added: true, id: triple.id, subject: triple.subject, predicate: triple.predicate, object: triple.object }) }] }
      } catch (e: unknown) {
        return errorResponse(e)
      }
    }
  )

  // Tool: memrecall_kg_query
  server.tool(
    'memrecall_kg_query',
    `Query knowledge graph for facts about an entity.

CALL WHEN:
- Need to know relationships of a person, project, or technology
- "What does X use?", "Who works on Y?", "What depends on Z?"`,
    {
      entity: z.string().describe('Subject or object to query'),
      predicate: z.string().optional().describe('Filter by relationship type'),
      project: z.string().optional().describe('Filter by project'),
      includeExpired: z.boolean().optional().default(false).describe('Include expired facts'),
    },
    async (params) => {
      try {
        const triples = queryTriples(db, {
          entity: params.entity,
          predicate: params.predicate,
          project: params.project,
          includeExpired: params.includeExpired,
        })

        if (triples.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No facts found.' }] }
        }

        const formatted = triples.map(t => {
          const since = t.validFrom.slice(0, 10)
          let line = `${t.subject} → ${t.predicate} → ${t.object} (since ${since})`
          if (t.validUntil) {
            line += ` (ended ${t.validUntil.slice(0, 10)})`
          }
          return line
        }).join('\n')

        return { content: [{ type: 'text' as const, text: formatted }] }
      } catch (e: unknown) {
        return errorResponse(e)
      }
    }
  )

  // Tool: memrecall_kg_invalidate
  server.tool(
    'memrecall_kg_invalidate',
    `Mark a knowledge graph triple as no longer valid. Sets valid_until timestamp.

CALL WHEN:
- A relationship has ended ("X no longer uses Y", "A left project B")`,
    {
      subject: z.string().describe('The entity'),
      predicate: z.string().describe('The relationship'),
      object: z.string().describe('The related entity'),
    },
    async (params) => {
      try {
        const invalidated = invalidateTriple(db, {
          subject: params.subject,
          predicate: params.predicate,
          object: params.object,
        })
        return { content: [{ type: 'text' as const, text: JSON.stringify({ invalidated }) }] }
      } catch (e: unknown) {
        return errorResponse(e)
      }
    }
  )

  // Tool: memrecall_mine
  server.tool(
    'memrecall_mine',
    `Mine conversation history to extract memories retroactively.

CALL WHEN:
- User asks to import or mine conversation history
- User wants to extract knowledge from past conversations

Usually run via CLI (memrecall mine), but can be triggered here too.`,
    {
      path: z.string().describe('Path to conversations directory or file (e.g., ~/.claude)'),
      project: z.string().optional().describe('Tag mined memories with this project'),
      extract: z.boolean().optional().default(false).describe('Smart extraction (decisions, feedback, bugs) instead of raw summaries'),
      dryRun: z.boolean().optional().default(false).describe('Preview without saving'),
    },
    async (params) => {
      try {
        const result = await mine(db, params.path, {
          project: params.project || defaultProject || undefined,
          extract: params.extract,
          dryRun: params.dryRun,
        })
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
      } catch (e: unknown) {
        return errorResponse(e)
      }
    }
  )

  // Resource: memrecall://context (optional, for clients that support @-references)
  server.resource(
    'context',
    'memrecall://context',
    async () => {
      const memories = getTopMemories(db, defaultProject ? [defaultProject] : null, 15)
      const formatted = memories.map(m =>
        `[${m.type}]${m.project ? ` (${m.project})` : ''} ${m.content}`
      ).join('\n')

      return {
        contents: [{
          uri: 'memrecall://context',
          mimeType: 'text/plain',
          text: formatted || 'No memories yet.',
        }]
      }
    }
  )

  // Connect via stdio
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
