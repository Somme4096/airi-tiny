import type { ChatPrepareRequestEvent, MetadataEventSource } from '@proj-airi/server-sdk'

import { CHAT_PREPARE_LABEL } from '@proj-airi/server-sdk'

import { getMetadataSourceLabel } from '../../../utils/event-source'

/**
 * The longest time a chat turn waits for its preparers.
 *
 * A preparer answers even when its own work fails, so the limit only matters when a module hangs or crashes.
 * It is long enough for a module that calls a model, for example a Dusha mod that classifies the user message.
 */
const PREPARE_TIMEOUT_MS = 20_000

/**
 * Holds a chat turn until the modules with the `chat-prepare` label have prepared it.
 *
 * Owned state:
 * - `preparers`: the source keys of the connected modules with the label. `registry:modules:sync` replaces it.
 * - `pending`: for each turn in preparation, the preparers that have not answered yet.
 *
 * Correlation: a response matches a turn by `turnId`, and a preparer by the source key of the response metadata.
 * A response for an unknown turn, for example a turn of another stage window, is ignored.
 */
export class ChatPrepareGate {
  private preparers = new Set<string>()
  private readonly pending = new Map<string, { waiting: Set<string>, done: () => void }>()

  /** Replaces the preparers. A preparer that disconnected stops holding the turns that wait for it. */
  syncModules(modules: Array<{ identity: MetadataEventSource }>) {
    this.preparers = new Set(modules.flatMap((module) => {
      const labels = 'labels' in module.identity ? module.identity.labels : undefined
      const key = getMetadataSourceLabel(module.identity)
      return labels?.[CHAT_PREPARE_LABEL] === 'true' && key ? [key] : []
    }))

    for (const turn of this.pending.values()) {
      for (const key of turn.waiting) {
        if (!this.preparers.has(key))
          turn.waiting.delete(key)
      }
      if (turn.waiting.size === 0)
        turn.done()
    }
  }

  /** Records the answer of one preparer. */
  respond(turnId: string, source?: MetadataEventSource) {
    const turn = this.pending.get(turnId)
    const key = getMetadataSourceLabel(source)
    if (!turn || !key)
      return

    turn.waiting.delete(key)
    if (turn.waiting.size === 0)
      turn.done()
  }

  /**
   * Sends the request and resolves when every preparer answered, or after {@link PREPARE_TIMEOUT_MS}.
   * Resolves at once and sends nothing when no preparer is connected.
   */
  async prepare(request: ChatPrepareRequestEvent, send: (request: ChatPrepareRequestEvent) => void) {
    if (this.preparers.size === 0)
      return

    const { promise, resolve } = Promise.withResolvers<void>()
    const timer = setTimeout(resolve, PREPARE_TIMEOUT_MS)
    this.pending.set(request.turnId, { waiting: new Set(this.preparers), done: resolve })

    try {
      send(request)
      await promise
    }
    finally {
      clearTimeout(timer)
      this.pending.delete(request.turnId)
    }
  }
}
