import { describe, it, expect } from 'vitest'
import { cosineSimilarity, embeddingToBuffer, bufferToEmbedding } from './embed.js'
import { EMBEDDING_DIMENSIONS } from './types.js'

describe('cosineSimilarity', () => {
  it('returns 1.0 for identical vectors', () => {
    const v = new Float32Array([1, 2, 3, 4])
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5)
  })

  it('returns 0.0 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0, 0])
    const b = new Float32Array([0, 1, 0])
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5)
  })

  it('returns -1.0 for opposite vectors', () => {
    const a = new Float32Array([1, 2, 3])
    const b = new Float32Array([-1, -2, -3])
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5)
  })

  it('returns 0 when a vector is all zeros', () => {
    const a = new Float32Array([0, 0, 0])
    const b = new Float32Array([1, 2, 3])
    expect(cosineSimilarity(a, b)).toBe(0)
  })
})

describe('embeddingToBuffer + bufferToEmbedding', () => {
  it('round-trip preserves values', () => {
    const original = new Float32Array([0.1, -0.5, 3.14, 0, -999.99])
    const buffer = embeddingToBuffer(original)
    const restored = bufferToEmbedding(buffer)
    expect(restored.length).toBe(original.length)
    for (let i = 0; i < original.length; i++) {
      expect(restored[i]).toBeCloseTo(original[i], 5)
    }
  })

  it('produces correct byte length', () => {
    const embedding = new Float32Array(EMBEDDING_DIMENSIONS)
    const buffer = embeddingToBuffer(embedding)
    // Float32 = 4 bytes per element
    expect(buffer.byteLength).toBe(EMBEDDING_DIMENSIONS * 4)
  })

  it('handles single-element vector', () => {
    const original = new Float32Array([42.0])
    const buffer = embeddingToBuffer(original)
    const restored = bufferToEmbedding(buffer)
    expect(restored.length).toBe(1)
    expect(restored[0]).toBeCloseTo(42.0, 5)
  })
})
