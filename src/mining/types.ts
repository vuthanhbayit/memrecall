export interface Message {
  role: 'user' | 'assistant'
  content: string
  timestamp?: string
}

export interface Conversation {
  id: string
  messages: Message[]
  metadata?: {
    project?: string
    date?: string
    source?: string // file path
  }
}

export interface ConversationParser {
  name: string
  detect(path: string): Promise<boolean>
  parse(path: string): AsyncIterable<Conversation>
}

export interface MinedMemory {
  type: 'decision' | 'feedback' | 'bug' | 'context' | 'reference'
  content: string
  tags: string[]
  source: string // conversation file path
}

export interface MineResult {
  parsed: number // conversations parsed
  extracted: number // memories extracted
  saved: number // actually saved (after dedup)
  skipped: number // skipped by dedup
}

export interface MineOptions {
  project?: string
  format?: string // force parser: 'claude-code'
  extract?: boolean // smart extraction (default: false = raw mode)
  dryRun?: boolean
}
