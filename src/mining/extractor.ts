import type { Conversation, MinedMemory } from './types.js'

/**
 * Remove Vietnamese diacritics from text.
 * "chốt quyết định" → "chot quyet dinh"
 * Allows matching both accented and unaccented Vietnamese input.
 */
export function removeDiacritics(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
}

// --- Pattern definitions ---
// Each group has English patterns (run on original text)
// and Vietnamese patterns (run on diacritics-stripped text so both
// "chốt dùng X" and "chot dung X" match).

const DECISION_PATTERNS_EN = [
  /(?:decided to|chose to|going with|let's use|we'll use|switching to|will use)\s+(.{10,200})/gi,
]

// Vietnamese decision patterns — require longer prefixes to avoid "dung" ambiguity
const DECISION_PATTERNS_VI = [
  /(?:chot (?:la |roi |dung |chon )|quyet dinh (?:dung |chon |lay )|chuyen sang |se dung |nen dung |da chon )(.{10,200})/gi,
]

const FEEDBACK_PATTERNS_EN = [
  /(?:don't ever|never ever|always prefer|always use|must not|should not|shouldn't ever)\s+(.{10,200})/gi,
  /(?:don't|do not)\s+(?:use|do|add|create|make|put|write|call|import|include|touch)\s+(.{10,200})/gi,
  /(?:stop|avoid|never)\s+(?:using|doing|adding|creating|making)\s+(.{10,200})/gi,
]

// Vietnamese feedback — use multi-word to avoid "dung" (use) vs "dung" (don't)
const FEEDBACK_PATTERNS_VI = [
  /(?:dung bao gio|khong bao gio|luon luon phai|khong duoc phep|tuyet doi khong|cam khong duoc|tranh viec)\s+(.{10,200})/gi,
]

const BUG_PATTERNS_EN = [
  /(?:root cause (?:was|is)|failed because|the issue was|bug was|caused by|broke because|error was due to|problem was)\s+(.{10,200})/gi,
]

// Vietnamese bug — require "la" or "do" after pattern to confirm it's a statement, not a question
const BUG_PATTERNS_VI = [
  /(?:nguyen nhan (?:la|do)|loi (?:la do|la vi|vi|do)|van de (?:la do|la vi)|bi loi (?:la |do |vi ))\s*(.{10,200})/gi,
]

interface PatternGroup {
  type: MinedMemory['type']
  enPatterns: RegExp[]
  viPatterns: RegExp[]
}

const PATTERN_GROUPS: PatternGroup[] = [
  { type: 'decision', enPatterns: DECISION_PATTERNS_EN, viPatterns: DECISION_PATTERNS_VI },
  { type: 'feedback', enPatterns: FEEDBACK_PATTERNS_EN, viPatterns: FEEDBACK_PATTERNS_VI },
  { type: 'bug', enPatterns: BUG_PATTERNS_EN, viPatterns: BUG_PATTERNS_VI },
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
 * Collect matches from a set of regex patterns against text.
 * Returns the matched substrings from the ORIGINAL text (not normalized).
 */
function collectMatches(text: string, patterns: RegExp[], offset?: { normalized: string; original: string }): string[] {
  const results: string[] = []
  const matchText = offset ? offset.normalized : text
  for (const pattern of patterns) {
    for (const match of matchText.matchAll(pattern)) {
      if (offset) {
        // For Vietnamese patterns matched on normalized text,
        // extract the same position from original text to preserve diacritics
        const start = match.index!
        const end = start + match[0].length
        const original = offset.original.slice(start, end).trim()
        if (original.length > 0) results.push(original)
      } else {
        const content = match[0].trim()
        if (content.length > 0) results.push(content)
      }
    }
  }
  return results
}

/**
 * Smart extract mode: scan all messages for keyword patterns.
 * English patterns match on original text.
 * Vietnamese patterns match on diacritics-stripped text, then extract from original.
 */
function extractSmart(conversation: Conversation): MinedMemory[] {
  const memories: MinedMemory[] = []
  const source = conversation.metadata?.source || conversation.id

  for (const message of conversation.messages) {
    const original = message.content
    const normalized = removeDiacritics(original.toLowerCase())

    for (const group of PATTERN_GROUPS) {
      // English patterns on original text
      for (const content of collectMatches(original, group.enPatterns)) {
        memories.push({ type: group.type, content, tags: ['mined', 'extracted'], source })
      }

      // Vietnamese patterns on normalized text, extract from original
      for (const content of collectMatches('', group.viPatterns, { normalized, original })) {
        memories.push({ type: group.type, content, tags: ['mined', 'extracted'], source })
      }
    }
  }

  return memories
}

/**
 * Extract memories from a conversation.
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
