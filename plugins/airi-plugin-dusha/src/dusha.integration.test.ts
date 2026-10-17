import { beforeAll, describe, expect, it } from 'vitest'

import { DushaClient } from './client'
import { createTools } from './tools'

/**
 * Runs every tool against a real Dusha service.
 *
 * The test writes messages, facts, and memos, and moves affect. Point `DUSHA_TEST_URL` only at a companion that
 * holds no real conversations, for example one started with `dusha --home <empty dir> serve`.
 */
const url = process.env.DUSHA_TEST_URL
const token = process.env.DUSHA_TEST_TOKEN ?? ''

describe.skipIf(!url)('dusha tools against a real Dusha service', () => {
  let client: DushaClient
  let tools: Map<string, ReturnType<typeof createTools>['tools'][number]>
  const call = (id: string, input: Record<string, unknown>) => tools.get(id)!.execute(input) as Promise<Record<string, any>>
  const key = `test.fact.${Date.now()}`

  // `describe.skipIf` still runs this body to collect the tests, so the client is built only when the tests run.
  beforeAll(() => {
    client = new DushaClient({ url: url!, token, harness: 'airi-test', conversationId: `airi-test-${Date.now()}`, timeoutSeconds: 30 })
    tools = new Map(createTools(client).tools.map(tool => [tool.id, tool]))
  })

  it('finds a stored message with search and reads it with its neighbors', async () => {
    const marker = `amber-window-${Date.now()}`
    const stored = await client.ingest({ role: 'user', content: `Remember the ${marker}.` })

    const search = await call('search_conversation_memory', { query: marker, limit: null })
    const record = await call('get_conversation_record', { memory_id: stored.id, context_messages: 0 })

    expect(search.ok).toBe(true)
    expect(search.records.map((item: { memory_id: number }) => item.memory_id)).toContain(stored.id)
    expect(record.records).toEqual([expect.objectContaining({ memory_id: stored.id, role: 'user' })])
  })

  it('runs an evergreen fact through remember, review, revise, history, and forget', async () => {
    const saved = await call('remember_evergreen_fact', { key, text: 'The user prefers Helix.', priority: 70, review_after: null, expires_at: null, reason: 'test' })
    const factId = saved.fact.fact_id
    const duplicate = await call('remember_evergreen_fact', { key, text: 'Again.', priority: null, review_after: null, expires_at: null, reason: null })
    const review = await call('review_evergreen_facts', { due_only: false, include_inactive: null, limit: 100 })
    const revised = await call('revise_evergreen_fact', { fact_id: factId, expected_revision: 1, text: 'The user prefers Helix and Fish.', priority: null, review_after: '2030-01-01T00:00:00Z', expires_at: null, reason: 'test' })
    const stale = await call('revise_evergreen_fact', { fact_id: factId, expected_revision: 1, text: 'Stale.', priority: null, review_after: null, expires_at: null, reason: null })
    const history = await call('evergreen_fact_history', { fact_id: factId })
    const forgotten = await call('forget_evergreen_fact', { fact_id: factId, expected_revision: 2, reason: 'test' })

    expect(saved).toMatchObject({ ok: true, fact: { key, revision: 1, priority: 70 } })
    expect(duplicate).toMatchObject({ ok: false, status: 409 })
    expect(review.facts.map((fact: { key: string }) => fact.key)).toContain(key)
    expect(revised).toMatchObject({ ok: true, fact: { revision: 2, priority: 70, text: 'The user prefers Helix and Fish.' } })
    expect(stale).toMatchObject({ ok: false, status: 409 })
    expect(history.revisions.length).toBeGreaterThanOrEqual(2)
    expect(forgotten).toMatchObject({ ok: true, fact: { state: 'forgotten' } })
  })

  it('runs a memo through add, list, and done', async () => {
    const added = await call('yumecho_add', { text: 'Ask how the interview went.' })
    const noteId = added.memo.id
    const active = await call('yumecho_list', { status: null, limit: null })
    const done = await call('yumecho_done', { note_id: noteId, reason: 'It went well.' })
    const archived = await call('yumecho_list', { status: 'archived', limit: 500 })

    expect(active.memos.map((memo: { id: number }) => memo.id)).toContain(noteId)
    expect(done).toMatchObject({ ok: true, memo: { status: 'archived' } })
    expect(archived.memos.map((memo: { id: number }) => memo.id)).toContain(noteId)
  })

  it('reads affect and builds a context that holds it', async () => {
    const status = await call('affect_status', {})
    const context = await client.context({ query: 'hello', excludeMessageIds: [], includeRecent: false })

    expect(status.ok).toBe(true)
    expect(Object.keys(status.affect.base).length).toBeGreaterThan(0)
    expect(context.injection).toContain('<affect>')
  })
})
