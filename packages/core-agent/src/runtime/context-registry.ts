import type { MetadataEventSource } from '@proj-airi/server-shared/types'

import type { ContextMessage } from '../types/chat'

const CONTEXT_UPDATE_REPLACE_SELF = 'replace-self'
const CONTEXT_UPDATE_APPEND_SELF = 'append-self'

interface EventSourcePayload {
  source?: string
  metadata?: { source?: MetadataEventSource }
}

/**
 * Stored context event with the registry bucket key resolved at ingest time.
 */
export interface ContextHistoryEntry extends ContextMessage {
  /** Stable source bucket key derived from metadata, source, or fallback. */
  sourceKey: string
}

/**
 * Observable result emitted when a context update mutates an active bucket.
 */
export interface ContextIngestResult {
  /** Stable source bucket key affected by the ingest. */
  sourceKey: string
  /** Registry mutation applied to the active bucket. */
  mutation: 'replace' | 'append'
  /** Number of active entries in the affected bucket after mutation. */
  entryCount: number
}

/**
 * Mutable runtime registry for active context buckets and bounded ingest history.
 */
export interface ContextRegistry {
  /** Stores a context message and returns a mutation summary for known strategies. */
  ingest: (envelope: ContextMessage) => ContextIngestResult | undefined
  /**
   * Removes the active bucket of one source, for example when its module disconnects.
   * The ingest history keeps the entries of that source.
   *
   * @returns `true` when the source had a bucket.
   */
  remove: (sourceKey: string) => boolean
  /** Clears active context buckets and ingest history. */
  reset: () => void
  /** Returns a cloned active context bucket snapshot. */
  snapshot: () => Record<string, ContextMessage[]>
  /** Returns cloned active context buckets for callers that prefer explicit naming. */
  activeContexts: () => Record<string, ContextMessage[]>
  /** Returns cloned ingest history entries in chronological order. */
  contextHistory: () => ContextHistoryEntry[]
}

interface CreateContextRegistryOptions {
  /**
   * Maximum number of history records retained by the registry.
   *
   * @default 400
   */
  historyLimit?: number
  /**
   * Maximum number of active entries in one source bucket. The oldest entries leave first.
   *
   * @default 20
   */
  bucketLimit?: number
  /**
   * Resolves a context message into a stable source bucket key.
   *
   * @default metadata extension/module key, then event source, then "unknown"
   */
  getSourceKey?: (event: EventSourcePayload, fallback?: string) => string
}

function formatMetadataSource(source?: MetadataEventSource) {
  if (!source)
    return undefined

  if ('extension' in source) {
    return `${source.extension.id}:${source.id}`
  }

  return source.id
}

function defaultGetSourceKey(event: EventSourcePayload, fallback = 'unknown') {
  return (
    formatMetadataSource(event.metadata?.source)
    ?? event.source
    ?? fallback
  )
}

/**
 * Creates a context registry that owns active buckets and bounded ingest history.
 *
 * Each source has one bucket. Inside a bucket, `lane` names a slot:
 * - A replace-self update replaces the entries of its own lane. Other lanes of the source stay.
 * - An append-self update adds an entry. A repeated `contextId` is a retry, so it replaces the first attempt.
 * - Updates without a lane share one slot.
 *
 * Use when:
 * - Runtime contexts need replace-self or append-self bucket semantics.
 * - UI or transport layers need cloned snapshots without owning mutation policy.
 *
 * Expects:
 * - Context messages are structured-cloneable before they enter the registry.
 * - Unknown strategies should still be recorded in history for observability.
 *
 * Returns:
 * - A registry whose snapshots cannot mutate internal active bucket state.
 */
export function createContextRegistry(options: CreateContextRegistryOptions = {}): ContextRegistry {
  const historyLimit = options.historyLimit ?? 400
  const bucketLimit = options.bucketLimit ?? 20
  const getSourceKey = options.getSourceKey ?? defaultGetSourceKey

  let currentActiveContexts = new Map<string, ContextMessage[]>()
  let currentContextHistory: ContextHistoryEntry[] = []

  function ingest(envelope: ContextMessage): ContextIngestResult | undefined {
    const sourceKey = getSourceKey(envelope)
    const safeEnvelopeToStore = structuredClone(envelope)

    const bucket = currentActiveContexts.get(sourceKey) ?? []

    let result: ContextIngestResult | undefined
    let nextBucket = bucket

    if (envelope.strategy === CONTEXT_UPDATE_REPLACE_SELF) {
      nextBucket = [...bucket.filter(message => message.lane !== envelope.lane), safeEnvelopeToStore]
      result = { sourceKey, mutation: 'replace', entryCount: 0 }
    }
    else if (envelope.strategy === CONTEXT_UPDATE_APPEND_SELF) {
      nextBucket = [...bucket.filter(message => message.contextId !== envelope.contextId), safeEnvelopeToStore]
      result = { sourceKey, mutation: 'append', entryCount: 0 }
    }

    nextBucket = nextBucket.slice(-bucketLimit)
    currentActiveContexts.set(sourceKey, nextBucket)
    if (result)
      result.entryCount = nextBucket.length

    currentContextHistory = [
      ...currentContextHistory,
      {
        ...safeEnvelopeToStore,
        sourceKey,
      },
    ].slice(-historyLimit)

    return result
  }

  function remove(sourceKey: string) {
    return currentActiveContexts.delete(sourceKey)
  }

  function reset() {
    currentActiveContexts = new Map<string, ContextMessage[]>()
    currentContextHistory = []
  }

  function snapshot() {
    return Object.fromEntries(
      Array.from(currentActiveContexts, ([sourceKey, messages]) => [
        sourceKey,
        structuredClone(messages),
      ]),
    )
  }

  return {
    ingest,
    remove,
    reset,
    snapshot,
    activeContexts: snapshot,
    contextHistory: () => structuredClone(currentContextHistory),
  }
}
