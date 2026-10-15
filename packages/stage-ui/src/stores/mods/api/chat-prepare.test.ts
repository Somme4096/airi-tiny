import type { ChatPrepareRequestEvent, MetadataEventSource } from '@proj-airi/server-sdk'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ChatPrepareGate } from './chat-prepare'

const request: ChatPrepareRequestEvent = { turnId: 'turn-1', sessionId: 'session-1', text: 'I am angry at you' }

function moduleIdentity(id: string, labels?: Record<string, string>): MetadataEventSource {
  return { id, extension: { id: 'airi-plugin-dusha' }, labels }
}

const preparer = moduleIdentity('dusha', { 'chat-prepare': 'true' })
const otherPreparer = moduleIdentity('memory', { 'chat-prepare': 'true' })
const plainModule = moduleIdentity('web-extension', { runtime: 'web-extension' })

afterEach(() => {
  vi.useRealTimers()
})

describe('chatPrepareGate', () => {
  it('sends nothing and does not wait when no module has the label', async () => {
    const gate = new ChatPrepareGate()
    const send = vi.fn()
    gate.syncModules([{ identity: plainModule }])

    await gate.prepare(request, send)

    expect(send).not.toHaveBeenCalled()
  })

  it('waits until every preparer answered', async () => {
    const gate = new ChatPrepareGate()
    const send = vi.fn()
    gate.syncModules([{ identity: preparer }, { identity: otherPreparer }, { identity: plainModule }])

    let prepared = false
    const preparing = gate.prepare(request, send).then(() => {
      prepared = true
    })
    gate.respond('turn-1', preparer)
    await Promise.resolve()

    expect(send).toHaveBeenCalledWith(request)
    expect(prepared).toBe(false)

    gate.respond('turn-1', otherPreparer)
    await preparing

    expect(prepared).toBe(true)
  })

  it('ignores answers for another turn and from modules without the label', async () => {
    const gate = new ChatPrepareGate()
    gate.syncModules([{ identity: preparer }])

    let prepared = false
    const preparing = gate.prepare(request, vi.fn()).then(() => {
      prepared = true
    })
    gate.respond('turn-2', preparer)
    gate.respond('turn-1', plainModule)
    await Promise.resolve()

    expect(prepared).toBe(false)

    gate.respond('turn-1', preparer)
    await preparing
  })

  it('stops waiting for a preparer that disconnects', async () => {
    const gate = new ChatPrepareGate()
    gate.syncModules([{ identity: preparer }])

    const preparing = gate.prepare(request, vi.fn())
    gate.syncModules([{ identity: plainModule }])

    await expect(preparing).resolves.toBeUndefined()
  })

  it('composes the turn after the time limit when a preparer never answers', async () => {
    vi.useFakeTimers()
    const gate = new ChatPrepareGate()
    gate.syncModules([{ identity: preparer }])

    let prepared = false
    const preparing = gate.prepare(request, vi.fn()).then(() => {
      prepared = true
    })
    await vi.advanceTimersByTimeAsync(19_999)

    expect(prepared).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await preparing

    expect(prepared).toBe(true)
  })
})
