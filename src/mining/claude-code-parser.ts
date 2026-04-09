import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import readline from 'readline'
import type { Conversation, ConversationParser, Message } from './types.js'

/**
 * Recursively find all .jsonl files under a directory.
 */
async function findJsonlFiles(dir: string): Promise<string[]> {
  const results: string[] = []
  const entries = await fsp.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const nested = await findJsonlFiles(fullPath)
      results.push(...nested)
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      results.push(fullPath)
    }
  }
  return results
}

/**
 * Extract text content from a JSONL message line.
 * Handles both `text` field and `content` array format.
 */
function extractText(parsed: Record<string, unknown>): string | null {
  if (typeof parsed.text === 'string' && parsed.text.length > 0) {
    return parsed.text
  }
  if (Array.isArray(parsed.content)) {
    const texts: string[] = []
    for (const block of parsed.content) {
      if (block && typeof block === 'object' && 'type' in block && block.type === 'text' && typeof block.text === 'string') {
        texts.push(block.text)
      }
    }
    if (texts.length > 0) return texts.join('\n')
  }
  return null
}

/**
 * Detect project name from a Claude Code path.
 * Pattern: ~/.claude/projects/-Users-admin-Desktop-PROJECT/conversations/...
 * Extracts the last meaningful segment from the encoded path.
 */
function detectProjectFromPath(filePath: string): string | undefined {
  const match = filePath.match(/\.claude\/projects\/([^/]+)/)
  if (!match) return undefined
  // The encoded path uses dashes: -Users-admin-Desktop-PROJECT
  const segments = match[1].split('-').filter(Boolean)
  if (segments.length === 0) return undefined
  // Return last segment as project name (lowercased)
  return segments[segments.length - 1].toLowerCase()
}

/**
 * Parse a single .jsonl file into a Conversation.
 */
async function parseJsonlFile(filePath: string): Promise<Conversation> {
  const messages: Message[] = []

  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

  for await (const line of rl) {
    const trimmed = line.trim()
    if (!trimmed) continue

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue // skip malformed lines
    }

    const type = parsed.type
    if (type !== 'human' && type !== 'assistant') continue

    const text = extractText(parsed)
    if (!text) continue

    const role: 'user' | 'assistant' = type === 'human' ? 'user' : 'assistant'
    messages.push({ role, content: text })
  }

  const project = detectProjectFromPath(filePath)
  const fileName = path.basename(filePath, '.jsonl')

  return {
    id: fileName,
    messages,
    metadata: {
      project,
      source: filePath,
    },
  }
}

export class ClaudeCodeParser implements ConversationParser {
  name = 'claude-code'

  async detect(targetPath: string): Promise<boolean> {
    try {
      const stat = await fsp.stat(targetPath)

      // Single .jsonl file
      if (stat.isFile() && targetPath.endsWith('.jsonl')) {
        return true
      }

      // Check if path looks like a Claude Code directory
      if (stat.isDirectory()) {
        // Direct ~/.claude pattern
        if (targetPath.includes('.claude')) return true

        // Check if directory contains .jsonl files (recurse one level)
        const entries = await fsp.readdir(targetPath, { withFileTypes: true })
        for (const entry of entries) {
          if (entry.isFile() && entry.name.endsWith('.jsonl')) return true
          if (entry.isDirectory() && entry.name === 'conversations') return true
        }
      }
    } catch {
      return false
    }

    return false
  }

  async *parse(targetPath: string): AsyncIterable<Conversation> {
    const stat = await fsp.stat(targetPath)

    let files: string[]
    if (stat.isFile()) {
      files = [targetPath]
    } else {
      files = await findJsonlFiles(targetPath)
    }

    for (const file of files) {
      const conversation = await parseJsonlFile(file)
      // Only yield conversations that have at least one message
      if (conversation.messages.length > 0) {
        yield conversation
      }
    }
  }
}
