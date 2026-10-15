import type { WebSocketEvents } from '@proj-airi/server-sdk'
import type { Emotion } from '@proj-airi/stage-ui/constants/emotions'

import type { AffectState, DushaClient, ProactiveEvent } from './client'

import { randomUUID } from 'node:crypto'

import { useLogg } from '@guiiai/logg'
import { errorMessageFrom } from '@moeru/std'
import { CHAT_PREPARE_LABEL, Client, ContextUpdateStrategy, WebSocketEventSource } from '@proj-airi/server-sdk'

import { describeRulingExpression, describeShift, messageShift, shiftEmotion } from './affect'

/** The `context:update` lane. A new update with this lane replaces the previous Dusha context in AIRI. */
const contextLane = 'dusha'

/**
 * The stage peers that run the character.
 *
 * The server channel matches a bare destination such as `character` against peer names, and no stage peer has
 * that name. The stage connects under its source name, so the notify names those.
 * Source: packages/server-runtime/src/middlewares/route/match-expression.ts, `matchesDestination`.
 */
const stageDestinations = [WebSocketEventSource.StageTamagotchi, WebSocketEventSource.StageWeb]

export interface StageBridgeOptions {
  dusha: DushaClient
  channel: { url: string, token: string }
  includeRecent: boolean
  proactive: { enabled: boolean, pollIntervalSeconds: number }
  expression: { enabled: boolean, minDelta: number, emotions: Record<string, Emotion> }
}

/**
 * Connects the AIRI stage to Dusha through the server channel.
 *
 * Owned state:
 * - `channel`: the server-channel connection. It reconnects on its own until {@link StageBridge.close}.
 * - `context`: the last Dusha context text sent to AIRI. AIRI drops the context of a module that disconnects,
 *   so the bridge sends it again each time the connection becomes ready.
 * - `turns`: a promise chain that handles one chat event at a time, so Dusha stores messages in chat order.
 * - `lastReplyId`: the stored ID of the last reply. AIRI holds the reply in its own history, so the next context
 *   leaves it out.
 * - `polling`: the proactive poll timer. It runs from the first ready connection to {@link StageBridge.close}.
 *
 * Turn flow. The connection carries the `chat-prepare` label, so AIRI waits for the bridge before each turn:
 * 1. `chat:prepare:request`: read affect, store the user message, read affect again, see {@link messageShift}.
 * 2. Send `character:emotion` for the shift, so the stage model shows the feeling before the reply starts.
 * 3. Send the Dusha context with the shift hint as `context:update`, then `chat:prepare:response`.
 * 4. `output:gen-ai:chat:message`: store the reply.
 */
export class StageBridge {
  private readonly logger = useLogg('airi-plugin-dusha').useGlobalConfig()
  private readonly channel: Client
  private context = ''
  private turns: Promise<void> = Promise.resolve()
  private lastReplyId: number | undefined
  private polling: ReturnType<typeof setTimeout> | undefined
  private closed = false

  constructor(private readonly options: StageBridgeOptions) {
    this.channel = new Client({
      name: 'airi-plugin-dusha',
      url: options.channel.url,
      token: options.channel.token || undefined,
      identity: { id: randomUUID(), extension: { id: 'airi-plugin-dusha' }, labels: { [CHAT_PREPARE_LABEL]: 'true' } },
      possibleEvents: ['context:update', 'chat:prepare:response', 'character:emotion', 'spark:notify'],
      autoConnect: false,
      onReady: () => this.onReady(),
      onError: error => this.logger.withError(error).warn('Server channel error'),
    })
    this.channel.onEvent('chat:prepare:request', (event) => {
      this.turns = this.turns.then(() => this.prepareTurn(event.data))
    })
    this.channel.onEvent('output:gen-ai:chat:message', (event) => {
      this.turns = this.turns.then(() => this.recordReply(event.data))
    })
  }

  /** Connects to the server channel. Proactive polling starts when the connection is first ready. Call it once. */
  start() {
    void this.channel.connect().catch(error => this.logger.withError(error).warn('Server channel connection failed, retrying'))
  }

  /** Stops polling, waits for the chat event in progress, and closes the connection. A leased event returns to pending when its lease ends. */
  async close() {
    this.closed = true
    clearTimeout(this.polling)
    await this.turns
    this.channel.close()
  }

  private onReady() {
    if (this.options.proactive.enabled && !this.polling)
      this.schedulePoll(0)

    if (this.context) {
      this.publish(this.context)
      return
    }
    void this.refreshContext('', [], '')
  }

  /**
   * Prepares one turn and always answers, so AIRI never waits for the full time limit.
   * When Dusha fails, AIRI composes the turn with the previous context.
   */
  private async prepareTurn(request: WebSocketEvents['chat:prepare:request']) {
    try {
      const text = request.text.trim()
      if (!text)
        return

      const before = await this.readAffect()
      const stored = await this.options.dusha.ingest({ role: 'user', content: text })
      const after = before && await this.readAffect()
      const shift = before && after ? messageShift(stored.affect?.emotion, before.base, after.base) : undefined

      let hint = ''
      if (this.options.expression.enabled) {
        const emotion = shiftEmotion(shift, this.options.expression)
        if (emotion)
          this.channel.send({ type: 'character:emotion', data: { name: emotion } })
        hint = describeShift(shift, this.options.expression)
      }

      const exclude = this.lastReplyId === undefined ? [stored.id] : [stored.id, this.lastReplyId]
      await this.refreshContext(text, exclude, hint)
    }
    catch (error) {
      this.logger.withError(error).warn('Turn preparation failed')
    }
    finally {
      this.channel.send({ type: 'chat:prepare:response', data: { turnId: request.turnId } })
    }
  }

  private async recordReply(data: WebSocketEvents['output:gen-ai:chat:message']) {
    const replyText = stripControlTokens(textOf(data.message.content))
    if (!replyText)
      return

    try {
      this.lastReplyId = (await this.options.dusha.ingest({ role: 'assistant', content: replyText })).id
    }
    catch (error) {
      this.logger.withError(error).warn('Reply archive failed')
    }
  }

  /**
   * Reads affect for the shift comparison.
   *
   * Returns `undefined` when the companion has affect turned off (HTTP 503) or the read fails. The turn still
   * gets stored and the context still gets sent, only without the affect hint.
   */
  private async readAffect(): Promise<AffectState | undefined> {
    try {
      return await this.options.dusha.affect()
    }
    catch {
      return undefined
    }
  }

  private async refreshContext(query: string, excludeMessageIds: number[], hint: string) {
    try {
      const { injection } = await this.options.dusha.context({ query, excludeMessageIds, includeRecent: this.options.includeRecent })
      this.context = [injection.trim(), hint].filter(Boolean).join('\n')
      this.publish(this.context)
    }
    catch (error) {
      this.logger.withError(error).warn('Context unavailable')
    }
  }

  private publish(text: string) {
    this.channel.send({
      type: 'context:update',
      data: { id: randomUUID(), contextId: contextLane, lane: contextLane, strategy: ContextUpdateStrategy.ReplaceSelf, text },
    })
  }

  private schedulePoll(delayMs: number) {
    if (this.closed)
      return
    this.polling = setTimeout(async () => {
      await this.deliverProactive()
      this.schedulePoll(this.options.proactive.pollIntervalSeconds * 1000)
    }, delayMs)
  }

  /**
   * Leases one proactive event and hands it to the character as `spark:notify`.
   *
   * The character answers the notify with its own reaction, which AIRI speaks and performs. AIRI does not send the
   * reaction text back to plugins, so the bridge acknowledges `sent` without text: Dusha counts the send and applies
   * its affect change, but the archive has no copy of the words.
   * While the channel is down, the bridge leases nothing. If a send fails after the lease, it releases the event
   * so that the next poll offers it again.
   */
  private async deliverProactive() {
    if (!this.channel.isReady)
      return

    let events: ProactiveEvent[]
    try {
      events = (await this.options.dusha.pollProactive(1)).events
    }
    catch (error) {
      this.logger.withError(error).warn('Proactive poll failed')
      return
    }

    for (const event of events) {
      const delivered = this.channel.send({
        type: 'spark:notify',
        data: {
          id: `dusha-proactive-${event.id}`,
          eventId: event.id,
          kind: 'ping',
          urgency: 'immediate',
          headline: `You want to reach out to the user (${event.reason}).`,
          note: [event.generation_instruction, this.rulingExpression(event)].filter(Boolean).join('\n'),
          payload: { dushaEventId: event.id, reason: event.reason },
          destinations: stageDestinations,
        },
      })

      try {
        await this.options.dusha.ackProactive(event.id, delivered ? 'sent' : 'release')
      }
      catch (error) {
        this.logger.withError(error).warn(`Proactive acknowledgement failed: ${errorMessageFrom(error)}`)
      }
    }
  }

  private rulingExpression(event: ProactiveEvent) {
    if (!this.options.expression.enabled)
      return ''
    return describeRulingExpression(event.ruling_feeling.dimension, this.options.expression.emotions)
  }
}

/**
 * Joins the text parts of a chat message.
 *
 * @example
 * textOf([{ type: 'text', text: 'Hello' }, { type: 'image_url', image_url: { url: 'airi-asset:1' } }])
 * // => 'Hello'
 */
function textOf(content: unknown): string {
  if (typeof content === 'string')
    return content.trim()
  if (!Array.isArray(content))
    return ''
  return content
    .filter((part): part is { type: 'text', text: string } => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n')
    .trim()
}

/**
 * Removes AIRI streaming control tokens. They drive the stage and carry no meaning for the archive.
 *
 * @example
 * stripControlTokens('<|ACT {"emotion":"happy"}|> Hi!')
 * // => 'Hi!'
 */
function stripControlTokens(text: string): string {
  return text.replace(/<\|[\s\S]*?\|>/g, '').replace(/[ \t]{2,}/g, ' ').trim()
}
