import type { Conversation, MinedMemory } from './types.js'

const DECISION_PATTERNS = [
  /(?:decided|chose|going with|let's use|we'll use|switching to)\s+(.{10,200})/i,
  /(?:chốt|quyết định|dùng|chuyển sang)\s+(.{10,200})/i,
]

const FEEDBACK_PATTERNS = [
  /(?:don't|never|stop|always prefer|always use)\s+(.{10,200})/i,
  /(?:đừng|không bao giờ|luôn luôn|luôn dùng)\s+(.{10,200})/i,
]

const BUG_PATTERNS = [
  /(?:root cause|failed because|the issue was|bug was|lỗi vì|nguyên nhân)\s+(.{10,200})/i,
]

interface PatternGroup {
  type: MinedMemory['type']
  patterns: RegExp[]
}

const PATTERN_GROUPS: PatternGroup[] = [
  { type: 'decision', patterns: DECISION_PATTERNS },
  { type: 'feedback', patterns: FEEDBACK_PATTERNS },
  { type: 'bug', patterns: BUG_PATTERNS },
]

/**
 * Raw mode: summarize entire conversation into 1 memory.
 * Takes first user message + first assistant response, truncated to 2000 chars total.
 */
function extractRaw(conversation: Conversation): MinedMemory[] {
  if (conversation.messages.length === 0) return []

  const firstUser = conversation.messages.find(m => m.role === 'user')
  const firstAssistant = conversation.messages.find(m => m.role === 'assistant')

  let content = ''
  if (firstUser) {
    content += firstUser.content
  }
  if (firstAssistant) {
    const remaining = 2000 - content.length
    if (remaining > 10) {
      content += '\n---\n' + firstAssistant.content
    }
  }

  if (content.length > 2000) {
    content = content.slice(0, 1997) + '...'
  }

  if (content.trim().length === 0) return []

  return [{
    type: 'context',
    content,
    tags: ['mined', 'claude-code'],
    source: conversation.metadata?.source || conversation.id,
  }]
}

/**
 * Smart extract mode: scan all messages for keyword patterns.
 * Returns one MinedMemory per pattern match.
 */
function extractSmart(conversation: Conversation): MinedMemory[] {
  const memories: MinedMemory[] = []
  const source = conversation.metadata?.source || conversation.id

  for (const message of conversation.messages) {
    for (const group of PATTERN_GROUPS) {
      for (const pattern of group.patterns) {
        const match = pattern.exec(message.content)
        if (match) {
          // Use the full match (match[0]) for context, trimmed
          const content = match[0].trim()
          if (content.length > 0) {
            memories.push({
              type: group.type,
              content,
              tags: ['mined', 'extracted'],
              source,
            })
          }
        }
      }
    }
  }

  return memories
}

/**
 * Extract memories from a conversation.
 *
 * @param conversation - The parsed conversation
 * @param extract - If true, use smart pattern extraction. If false (default), use raw summary mode.
 * @returns Array of mined memories
 */
export function extractMemories(conversation: Conversation, extract: boolean): MinedMemory[] {
  if (extract) {
    return extractSmart(conversation)
  }
  return extractRaw(conversation)
}

/**
 * Calculate word overlap ratio between two strings.
 * Returns a value between 0.0 (no overlap) and 1.0 (identical words).
 */
export function wordOverlap(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 0))
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 0))

  if (wordsA.size === 0 && wordsB.size === 0) return 1.0
  if (wordsA.size === 0 || wordsB.size === 0) return 0.0

  const intersection = [...wordsA].filter(w => wordsB.has(w))
  return intersection.length / Math.max(wordsA.size, wordsB.size)
}
