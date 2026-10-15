import { errorMessageFrom } from '@moeru/std'

/** Emotion values by dimension name. Dusha's `emotions.json` owns the names. */
export type AffectValues = Record<string, number>

export interface AffectState {
  /** The fast layer that messages move. The Affect line in the injection reads this layer. */
  base: AffectValues
  /** The slow layer that follows `base` over hours. */
  mood: AffectValues
  last_updated_at: string
  last_user_message_at: string | null
  last_proactive_sent_at: string | null
  unanswered_proactive: number
}

export interface IngestRequest {
  role: 'user' | 'assistant'
  content: string
}

export interface IngestResponse {
  id: number
  duplicate: boolean
  /** Set only when a single emotion was picked. Mod deltas can move affect while this stays `null`. */
  affect: { emotion: string, increment: number, decision_id: number | null, state: AffectState } | null
}

export interface ContextResponse {
  /** The full text to give the model, already in the order and delimiters that Dusha's `prompts.json` sets. */
  injection: string
}

export interface StoredMessage {
  id: number
  role: string
  text: string
  occurred_at: string
}

export interface EvergreenFact {
  fact_id: string
  revision: number
  key: string
  text: string
  state: string
  effective_state: string
  priority: number
}

export interface ProactiveEvent {
  id: string
  reason: string
  generation_instruction: string
  ruling_feeling: { dimension: string, value: number, neutral: number, deviation: number }
}

export type ProactiveOutcome = 'sent' | 'failed' | 'release'

/** A Dusha response with a non-2xx status. `detail` is the FastAPI error text when the body has one. */
export class DushaRequestError extends Error {
  constructor(readonly status: number, readonly detail: string) {
    super(detail || `Dusha answered with HTTP ${status}`)
  }
}

type Query = Record<string, string | number | boolean>

/**
 * HTTP client for the Dusha state API.
 *
 * The client is stateless. Each call is one request to `/state/v1/*` with the companion token and a timeout.
 * Route reference: https://github.com/Somme4096/dusha/blob/main/docs/api.md
 */
export class DushaClient {
  private readonly baseUrl: string

  constructor(private readonly options: {
    url: string
    token: string
    harness: string
    conversationId: string
    timeoutSeconds: number
  }) {
    this.baseUrl = options.url.replace(/\/+$/, '')
  }

  /** The service status and the companion name. This route needs no token. */
  health() {
    return this.request<{ status: string, companion?: string, mods?: string[] }>('GET', '/health')
  }

  /** Stores one message. A user message also moves affect, so read affect before and after to see the change. */
  ingest(message: IngestRequest) {
    return this.request<IngestResponse>('POST', '/state/v1/messages', {
      harness: this.options.harness,
      conversation_id: this.options.conversationId,
      route: this.options.harness,
      ...message,
    })
  }

  /** Builds the injection. Dusha stores nothing for this call. */
  context(request: { query: string, excludeMessageIds: number[], includeRecent: boolean }) {
    return this.request<ContextResponse>('POST', '/state/v1/context', {
      harness: this.options.harness,
      conversation_id: this.options.conversationId,
      query: request.query,
      exclude_message_ids: request.excludeMessageIds,
      include_recent: request.includeRecent,
    })
  }

  /** Reads affect. The read advances decay and silence drift to now and saves the result. */
  affect() {
    return this.request<AffectState>('GET', '/state/v1/affect')
  }

  searchMemory(query: string, limit: number) {
    return this.request<{ results: Array<{ messages: StoredMessage[] }> }>('POST', '/state/v1/memory/search', {
      query,
      limit,
      context_messages: 0,
    })
  }

  readMemory(messageId: number, contextMessages: number) {
    return this.request<{ messages: StoredMessage[] }>('GET', `/state/v1/memory/${messageId}`, undefined, {
      context_messages: contextMessages,
    })
  }

  rememberFact(fact: Record<string, unknown>) {
    return this.request<{ fact: EvergreenFact }>('POST', '/state/v1/evergreen/facts', fact)
  }

  listFacts(query: { due_only: boolean, include_inactive: boolean, limit: number }) {
    return this.request<{ facts: EvergreenFact[] }>('GET', '/state/v1/evergreen/facts', undefined, query)
  }

  factHistory(factId: string) {
    return this.request<{ revisions: unknown[] }>('GET', `/state/v1/evergreen/facts/${encodeURIComponent(factId)}/history`)
  }

  reviseFact(factId: string, revision: Record<string, unknown>) {
    return this.request<{ fact: EvergreenFact }>('POST', `/state/v1/evergreen/facts/${encodeURIComponent(factId)}/revisions`, revision)
  }

  forgetFact(factId: string, request: { expected_revision: number, reason: string }) {
    return this.request<{ fact: EvergreenFact }>('POST', `/state/v1/evergreen/facts/${encodeURIComponent(factId)}/forget`, request)
  }

  addMemo(text: string) {
    return this.request<{ memo: unknown }>('POST', '/state/v1/memo/add', { text })
  }

  listMemos(status: 'active' | 'archived', limit: number) {
    return this.request<{ memos: unknown[] }>('GET', '/state/v1/memo/list', undefined, { status, limit })
  }

  completeMemo(noteId: number, reason: string) {
    return this.request<{ memo: unknown }>('POST', `/state/v1/memo/${noteId}/done`, { reason })
  }

  /** Leases pending events to this harness. A lease that expires before {@link ackProactive} returns the event to pending. */
  pollProactive(limit: number) {
    return this.request<{ events: ProactiveEvent[] }>('GET', '/state/v1/proactive/events', undefined, {
      consumer: this.options.harness,
      harness: this.options.harness,
      limit,
    })
  }

  /** `sent` with empty text counts the send and applies its affect change, but stores no message. */
  ackProactive(eventId: string, outcome: ProactiveOutcome, details: { text?: string, error?: string } = {}) {
    return this.request<unknown>('POST', `/state/v1/proactive/events/${encodeURIComponent(eventId)}/ack`, {
      consumer: this.options.harness,
      outcome,
      text: details.text ?? '',
      error: details.error ?? '',
    })
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown, query?: Query): Promise<T> {
    const url = new URL(this.baseUrl + path)
    if (query) {
      for (const [key, value] of Object.entries(query))
        url.searchParams.set(key, String(value))
    }

    const headers: Record<string, string> = {}
    if (this.options.token)
      headers['X-Companion-Token'] = this.options.token

    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(this.options.timeoutSeconds * 1000) }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(body)
    }

    let response: Response
    try {
      response = await fetch(url, init)
    }
    catch (error) {
      throw new Error(`Cannot reach Dusha at ${this.baseUrl}: ${errorMessageFrom(error) ?? 'unknown error'}`)
    }

    if (!response.ok)
      throw new DushaRequestError(response.status, await readErrorDetail(response))

    return await response.json() as T
  }
}

/** FastAPI puts a string `detail` on its own errors and a list of issues on validation errors. */
async function readErrorDetail(response: Response): Promise<string> {
  try {
    const body = await response.json() as { detail?: unknown }
    if (typeof body.detail === 'string')
      return body.detail
    if (body.detail !== undefined)
      return JSON.stringify(body.detail)
  }
  catch {
    // The body is not JSON, for example a proxy error page. The status alone still tells the cause.
  }
  return ''
}
