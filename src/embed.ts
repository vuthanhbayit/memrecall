import type { EmbeddingProvider } from './types.js'
import { EMBEDDING_DIMENSIONS } from './types.js'

// --- Cached provider (resolved once per process) ---

let cachedProvider: EmbeddingProvider | null | undefined

// --- Ollama provider ---

const OLLAMA_BASE = 'http://localhost:11434'
const OLLAMA_MODEL = 'all-minilm'
const OLLAMA_DETECT_TIMEOUT = 2000
const OLLAMA_EMBED_TIMEOUT = 10000

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

export async function createOllamaProvider(): Promise<EmbeddingProvider | null> {
  try {
    await fetchWithTimeout(`${OLLAMA_BASE}/api/tags`, {}, OLLAMA_DETECT_TIMEOUT)
  } catch {
    return null
  }

  async function embed(text: string): Promise<Float32Array> {
    const res = await fetchWithTimeout(
      `${OLLAMA_BASE}/api/embeddings`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: OLLAMA_MODEL, prompt: text }),
      },
      OLLAMA_EMBED_TIMEOUT,
    )
    if (!res.ok) {
      throw new Error(`Ollama embedding failed: ${res.status}`)
    }
    const data = (await res.json()) as { embedding: number[] }
    return new Float32Array(data.embedding)
  }

  // Sequential — Ollama /api/embeddings only accepts single input per request
  async function embedBatch(texts: string[]): Promise<Float32Array[]> {
    const results: Float32Array[] = []
    for (const text of texts) {
      results.push(await embed(text))
    }
    return results
  }

  return {
    name: 'ollama',
    dimensions: EMBEDDING_DIMENSIONS,
    embed,
    embedBatch,
  }
}

// --- Transformers provider (optional dependency, lazy-loaded) ---

export async function createTransformersProvider(): Promise<EmbeddingProvider | null> {
  let pipeline: any
  try {
    // @ts-ignore — @huggingface/transformers is an optional dependency (not in devDeps)
    const mod = await import('@huggingface/transformers')
    pipeline = mod.pipeline
  } catch {
    return null
  }

  let extractor: any

  async function getExtractor() {
    if (!extractor) {
      try {
        extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')
      } catch (err: unknown) {
        console.error('[memrecall] Failed to create transformers pipeline:', err)
        return null
      }
    }
    return extractor
  }

  // Verify pipeline can be created before returning the provider
  const ext = await getExtractor()
  if (!ext) return null

  async function embed(text: string): Promise<Float32Array> {
    const ext = await getExtractor()
    const output = await ext(text, { pooling: 'mean', normalize: true })
    return new Float32Array(output.data)
  }

  // Sequential — transformers.js pipeline is single-threaded ONNX inference
  async function embedBatch(texts: string[]): Promise<Float32Array[]> {
    const results: Float32Array[] = []
    for (const text of texts) {
      results.push(await embed(text))
    }
    return results
  }

  return {
    name: 'transformers',
    dimensions: EMBEDDING_DIMENSIONS,
    embed,
    embedBatch,
  }
}

// --- Provider initialization ---

async function initProvider(): Promise<EmbeddingProvider | null> {
  // Try Ollama first
  const ollama = await createOllamaProvider()
  if (ollama) {
    console.error('[memrecall] Embedding provider: ollama')
    return ollama
  }

  // Try transformers
  const transformers = await createTransformersProvider()
  if (transformers) {
    console.error('[memrecall] Embedding provider: transformers')
    return transformers
  }

  console.error('[memrecall] Embedding provider: none (FTS5 only)')
  return null
}

export async function getProvider(): Promise<EmbeddingProvider | null> {
  if (cachedProvider === undefined) {
    cachedProvider = await initProvider()
  }
  return cachedProvider
}

// --- Convenience wrappers ---

export async function embedText(text: string): Promise<Float32Array | null> {
  try {
    const provider = await getProvider()
    if (!provider) return null
    return await provider.embed(text)
  } catch {
    return null
  }
}

// --- Buffer conversion utilities ---

export function embeddingToBuffer(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength)
}

export function bufferToEmbedding(buffer: Buffer): Float32Array {
  const copy = new ArrayBuffer(buffer.byteLength)
  const view = new Uint8Array(copy)
  view.set(buffer)
  return new Float32Array(copy)
}

// --- Similarity ---

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  if (denom === 0) return 0
  return dot / denom
}
