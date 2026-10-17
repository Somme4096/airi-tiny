import memoryDriver from 'unstorage/drivers/memory'

import { createStorage } from 'unstorage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Replace the IDB-backed storage with an in-memory driver for tests; the
// repo's behavior is identical regardless of the underlying driver.
vi.mock('../storage', () => ({
  storage: createStorage({ driver: memoryDriver() }),
}))
vi.mock('./chat-assets.repo')

const { chatSessionsRepo } = await import('./chat-sessions.repo')
const { storage } = await import('../storage')

beforeEach(async () => {
  await storage.clear()
})

describe('chatSessionsRepo.clear', () => {
  /**
   * @example
   * clear() removes the index and its sessions.
   */
  it('removes the index and its sessions', async () => {
    await chatSessionsRepo.saveIndex({
      userId: 'user-1',
      characters: { 'char-a': { activeSessionId: 's1', sessions: { s1: { sessionId: 's1', userId: 'user-1', characterId: 'char-a', createdAt: 0, updatedAt: 0 } } } },
    })
    await chatSessionsRepo.saveSession('s1', { meta: { sessionId: 's1', userId: 'user-1', characterId: 'char-a', createdAt: 0, updatedAt: 0 }, messages: [] })

    await chatSessionsRepo.clear('user-1')

    expect(await chatSessionsRepo.getIndex('user-1')).toBeNull()
    expect(await chatSessionsRepo.getSession('s1')).toBeNull()
  })
})
