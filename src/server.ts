import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { createDatabase } from './db.js'
import { createMemory, updateMemory, expireMemory, getStats, errorResponse } from './memories.js'
import { searchMemories, getTopMemories } from './search.js'
import type { MemoryType } from './types.js'

export async function startServer() {
  const db = createDatabase()
  const defaultProject = process.env.MEMRECALL_PROJECT || null

  const server = new McpServer({
    name: 'memrecall',
    version: '0.1.0',
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

BEFORE SAVING: Search existing memories for similar content with memrecall_recall.
If a similar memory exists, use memrecall_update instead of creating a duplicate.`,
    {
      type: z.enum(['decision', 'feedback', 'bug', 'context', 'reference']).describe('Memory type'),
      content: z.string().describe('The memory content. Be specific and include reasoning.'),
      project: z.string().optional().describe('Project identifier (lowercase slug). Omit for global memories.'),
      tags: z.array(z.string()).optional().describe('Optional categorization tags.'),
    },
    async (params) => {
      try {
        const memory = createMemory(db, {
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
        const results = params.query
          ? searchMemories(db, { query: params.query, projects, type: params.type as MemoryType | undefined, limit: params.limit })
          : getTopMemories(db, projects ?? (defaultProject ? [defaultProject] : null), params.limit ?? 15, params.type as MemoryType | undefined)

        const formatted = results.map(m =>
          `[${m.type}]${m.project ? ` (${m.project})` : ''} ${m.content} {id:${m.id}}`
        ).join('\n')

        return { content: [{ type: 'text' as const, text: formatted || 'No memories found.' }] }
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
