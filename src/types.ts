export type MemoryType = 'decision' | 'feedback' | 'bug' | 'context' | 'reference'

export interface Memory {
  id: string
  type: MemoryType
  content: string
  weight: number
  project: string | null
  tags: string[] | null
  validFrom: string
  validUntil: string | null
  accessCount: number
  lastAccessedAt: string | null
  createdAt: string
}

export interface CreateMemoryInput {
  type: MemoryType
  content: string
  project?: string
  tags?: string[]
}

export interface SearchInput {
  query?: string
  projects?: string[]
  type?: MemoryType
  limit?: number
}

export interface UpdateMemoryInput {
  id: string
  content: string
}

export interface MemoryStats {
  total: number
  active: number
  expired: number
  byType: Record<MemoryType, number>
  byProject: Record<string, number>
}

export const TYPE_WEIGHTS: Record<MemoryType, number> = {
  decision: 1.0,
  feedback: 0.9,
  bug: 0.7,
  reference: 0.6,
  context: 0.5,
}

export const TYPE_HALF_LIFE_DAYS: Record<MemoryType, number> = {
  decision: 730,
  feedback: 730,
  bug: 180,
  reference: 365,
  context: 180,
}

export const MEMORY_TYPES: MemoryType[] = ['decision', 'feedback', 'bug', 'context', 'reference']

export const MAX_CONTENT_LENGTH = 2000
