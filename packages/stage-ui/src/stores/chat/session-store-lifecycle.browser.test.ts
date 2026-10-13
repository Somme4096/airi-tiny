import type { ChatSessionMeta, ChatSessionRecord, ChatSessionsIndex } from '../../types/chat-session'

import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, defineComponent, h, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'

import { useAiriCardStore } from '../modules/airi-card'

let pinia: ReturnType<typeof createPinia>

// Change real store state while storage calls remain external test boundaries.
const activeCardIdRef = computed({
  get: () => useAiriCardStore(pinia).activeCardId,
  set: (id: string) => { useAiriCardStore(pinia).activeCardId = id },
})
const systemPromptRef = computed({
  get: () => useAiriCardStore(pinia).systemPrompt,
  set: (prompt: string) => {
    const card = useAiriCardStore(pinia).getCard('default')
    if (!card)
      throw new Error('Missing test character')
    card.systemPrompt = prompt
  },
})

const getIndexMock = vi.fn<(uid: string) => Promise<ChatSessionsIndex | null>>()
const saveIndexMock = vi.fn<(idx: ChatSessionsIndex) => Promise<void>>()
const getSessionMock = vi.fn<(id: string) => Promise<ChatSessionRecord | null>>()
const saveSessionMock = vi.fn<(id: string, rec: ChatSessionRecord) => Promise<void>>()
const deleteSessionRepoMock = vi.fn<(id: string) => Promise<void>>()
const releaseAssetsMock = vi.fn<(id: string, ids: Iterable<string>) => Promise<void>>()

vi.mock('../../database/repos/chat-sessions.repo', () => ({
  chatSessionsRepo: {
    getIndex: (uid: string) => getIndexMock(uid),
    saveIndex: (idx: ChatSessionsIndex) => saveIndexMock(idx),
    getSession: (id: string) => getSessionMock(id),
    saveSession: (id: string, rec: ChatSessionRecord) => saveSessionMock(id, rec),
    deleteSession: (id: string) => deleteSessionRepoMock(id),
    releaseAssets: (id: string, ids: Iterable<string>) => releaseAssetsMock(id, ids),
  },
}))

const { useChatSessionStore } = await import('./session-store')
let app: ReturnType<typeof createApp>
let container: HTMLDivElement

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  localStorage.clear()
  app = createApp(defineComponent({ setup() {
    useAiriCardStore().cards.set('default', {
      name: 'Test character',
      version: '1.0',
      extensions: { airi: { agents: {}, modules: {
        consciousness: { provider: '', model: '' },
        vision: { provider: '', model: '' },
        speech: { provider: '', model: '', voice_id: '' },
      } } },
    })
    return () => h('div')
  } }))
  app.use(pinia).use(createI18n({ legacy: false, locale: 'en', messages: { en: {} }, missingWarn: false, fallbackWarn: false }))
  container = document.createElement('div')
  document.body.append(container)
  app.mount(container)
  activeCardIdRef.value = 'default'
  systemPromptRef.value = ''

  getIndexMock.mockReset().mockResolvedValue(null)
  saveIndexMock.mockReset().mockResolvedValue(undefined)
  getSessionMock.mockReset().mockResolvedValue(null)
  saveSessionMock.mockReset().mockResolvedValue(undefined)
  deleteSessionRepoMock.mockReset().mockResolvedValue(undefined)
  releaseAssetsMock.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  app.unmount()
  container.remove()
  disposePinia(pinia)
  localStorage.clear()
})

async function flushMicrotasks(rounds = 8) {
  for (let i = 0; i < rounds; i++)
    await Promise.resolve()
}

describe('chat-session-store · loadSession vs concurrent deleteSession', () => {
  // ROOT CAUSE: Deleting a session during IndexedDB loading could restore its old record. loadSession now checks whether the session still exists after reading storage.
  it('does not resurrect a session deleted while loadSession was awaiting IDB', async () => {
    const meta: ChatSessionMeta = {
      sessionId: 'sess-1',
      userId: 'local',
      characterId: 'default',
      createdAt: 1,
      updatedAt: 1,
    }

    let resolveGet: ((rec: ChatSessionRecord | null) => void) | undefined
    getSessionMock.mockImplementation((id: string) => {
      if (id === 'sess-1') {
        return new Promise<ChatSessionRecord | null>((resolve) => {
          resolveGet = resolve
        })
      }
      return Promise.resolve(null)
    })

    const store = useChatSessionStore()

    // Inject sess-1 into sessionMetas without going through createSession
    // (which would also pre-mark it loaded and short-circuit our test).
    store.applyRemoteSnapshot({
      activeSessionId: '',
      sessionMessages: {},
      sessionMetas: { 'sess-1': meta },
      index: null,
    })
    expect(store.sessionMetas['sess-1']).toBeDefined()

    // Start loadSession (don't await). getSession is now pending.
    const loadPromise = store.loadSession('sess-1')
    await flushMicrotasks()
    expect(resolveGet).toBeDefined()

    // Delete the session. In-memory clear is synchronous; IDB delete enqueues.
    await store.deleteSession('sess-1')
    expect(store.sessionMetas['sess-1']).toBeUndefined()

    // Resolve getSession with the stale stored record.
    resolveGet!({ meta, messages: [{ role: 'user', content: 'hi', id: 'm1' } as any] })
    await loadPromise
    await flushMicrotasks()

    // Without the fix, sess-1 reappears here.
    expect(store.sessionMetas['sess-1']).toBeUndefined()
  })
})

describe('chat-session-store · deletion and hydration failures', () => {
  // https://github.com/moeru-ai/airi/pull/2086#discussion_r3743502031
  it('persists the fallback without changing the leader selection when a follower deletes its active session for Issue #2085', async () => {
    // ROOT CAUSE:
    //
    // Session selection is window-local, so the synchronized leader can be on
    // A while the persisted index still points to B. Deleting B returned A but
    // left the persisted index empty, so the next startup created a blank chat.
    const sessionA: ChatSessionMeta = {
      sessionId: 'session-a',
      userId: 'local',
      characterId: 'default',
      createdAt: 1,
      updatedAt: 1,
    }
    const sessionB: ChatSessionMeta = {
      sessionId: 'session-b',
      userId: 'local',
      characterId: 'default',
      createdAt: 2,
      updatedAt: 2,
    }
    const store = useChatSessionStore()
    store.applyRemoteSnapshot({
      activeSessionId: 'session-a',
      sessionMessages: { 'session-a': [], 'session-b': [] },
      sessionMetas: { 'session-a': sessionA, 'session-b': sessionB },
      index: {
        userId: 'local',
        characters: {
          default: {
            activeSessionId: 'session-b',
            sessions: { 'session-a': sessionA, 'session-b': sessionB },
          },
        },
      },
    })

    await store.deleteSession('session-b')

    expect(store.activeSessionId).toBe('session-a')
    expect(store.getSnapshot().index?.characters.default?.activeSessionId).toBe('session-a')
    expect(store.sessionMetas['session-b']).toBeUndefined()
    expect(saveIndexMock).toHaveBeenLastCalledWith(expect.objectContaining({
      characters: expect.objectContaining({
        default: expect.objectContaining({ activeSessionId: 'session-a' }),
      }),
    }))
  })

  // https://github.com/moeru-ai/airi/pull/2086#discussion_r3743309237
  it('persists a replacement fallback without changing an unrelated leader selection for Issue #2085', async () => {
    // ROOT CAUSE:
    //
    // When a follower deleted the final session for one character, the leader
    // created a replacement with local activation disabled. The replacement
    // was indexed but the persisted character active ID stayed empty, so the
    // next initialization created another blank conversation.
    const leaderSession: ChatSessionMeta = {
      sessionId: 'leader-session',
      userId: 'local',
      characterId: 'other-character',
      createdAt: 1,
      updatedAt: 1,
    }
    const deletedSession: ChatSessionMeta = {
      sessionId: 'deleted-session',
      userId: 'local',
      characterId: 'default',
      createdAt: 2,
      updatedAt: 2,
    }
    const store = useChatSessionStore()
    store.applyRemoteSnapshot({
      activeSessionId: 'leader-session',
      sessionMessages: { 'leader-session': [], 'deleted-session': [] },
      sessionMetas: { 'leader-session': leaderSession, 'deleted-session': deletedSession },
      index: {
        userId: 'local',
        characters: {
          'other-character': {
            activeSessionId: 'leader-session',
            sessions: { 'leader-session': leaderSession },
          },
          'default': {
            activeSessionId: 'deleted-session',
            sessions: { 'deleted-session': deletedSession },
          },
        },
      },
    })

    await store.deleteSession('deleted-session')
    const snapshot = store.getSnapshot()
    const [replacementSessionId] = Object.keys(snapshot.index?.characters.default?.sessions ?? {})
    expect(replacementSessionId).toBeDefined()
    if (!replacementSessionId)
      throw new Error('Expected deletion to create a replacement session')

    expect(store.activeSessionId).toBe('leader-session')
    expect(snapshot.index?.characters.default?.activeSessionId).toBe(replacementSessionId)
    expect(snapshot.index?.characters.default?.sessions[replacementSessionId]).toBeDefined()
    expect(saveIndexMock).toHaveBeenLastCalledWith(expect.objectContaining({
      characters: expect.objectContaining({
        default: expect.objectContaining({ activeSessionId: replacementSessionId }),
      }),
    }))
  })

  // https://github.com/moeru-ai/airi/pull/2086#discussion_r3628917803
  it('keeps deleted session generations invalid for Issue #2085', async () => {
    // ROOT CAUSE:
    //
    // Deletion previously removed the generation entry. A send captured at
    // generation zero could then read the deleted session as generation zero
    // again and continue appending messages after the chat was gone.
    const meta: ChatSessionMeta = {
      sessionId: 'sess-1',
      userId: 'local',
      characterId: 'default',
      createdAt: 1,
      updatedAt: 1,
    }
    const store = useChatSessionStore()
    store.applyRemoteSnapshot({
      activeSessionId: 'sess-1',
      sessionMessages: { 'sess-1': [] },
      sessionMetas: { 'sess-1': meta },
      index: null,
    })

    expect(store.getSessionGeneration('sess-1')).toBe(0)

    await store.deleteSession('sess-1')

    expect(store.getSessionGeneration('sess-1')).toBe(1)
  })

  // https://github.com/moeru-ai/airi/pull/2086#discussion_r3628003766
  it('reports hydration failure and permits a later retry for Issue #2085', async () => {
    const meta: ChatSessionMeta = {
      sessionId: 'sess-1',
      userId: 'local',
      characterId: 'default',
      createdAt: 1,
      updatedAt: 1,
    }
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    getSessionMock
      .mockRejectedValueOnce(new Error('IndexedDB read failed'))
      .mockResolvedValueOnce(null)

    const store = useChatSessionStore()
    store.applyRemoteSnapshot({
      activeSessionId: '',
      sessionMessages: {},
      sessionMetas: { 'sess-1': meta },
      index: null,
    })

    await expect(store.loadSession('sess-1')).resolves.toBe(false)
    await expect(store.loadSession('sess-1')).resolves.toBe(true)

    expect(getSessionMock).toHaveBeenCalledTimes(2)
  })
})

describe('chat-session-store · active card prompt edits', () => {
  // https://github.com/moeru-ai/airi/discussions/2239
  it('adds the AIRI chat math syntax to the system message for Issue #2239', async () => {
    const store = useChatSessionStore()
    await store.initialize()

    const content = store.messages[0]?.content

    expect(content).toContain('Use $$...$$ for inline math.')
    expect(content).toContain('Use a separate multiline $$ block for each display equation.')
    expect(content).toContain('Use a latex fence for a list of independent one-line equations.')
    expect(content).toContain('Use a math fence for one multiline equation or LaTeX environment.')
    expect(content).toContain('Do not use single dollar signs as math delimiters.')
    expect(content).not.toContain('eg: $ x^3 $')
  })

  // ROOT CAUSE: Prompt edits left existing sessions with stale system messages. The session now replaces that message when the resolved prompt changes. Message identity and conversation history remain intact.
  // https://github.com/moeru-ai/airi/issues/1995
  it('updates the current session system message for Issue #1995 without clearing its history', async () => {
    systemPromptRef.value = 'Original character prompt'
    const store = useChatSessionStore()
    await store.initialize()

    const sessionId = store.activeSessionId
    const originalSystemMessage = store.messages[0]
    store.appendSessionMessage(sessionId, {
      role: 'user',
      content: 'Keep this turn.',
      id: 'user-message',
      createdAt: 2,
    })

    systemPromptRef.value = 'Updated character prompt'
    await nextTick()

    expect(store.messages).toHaveLength(2)
    expect(store.messages[0]?.role).toBe('system')
    expect(store.messages[0]?.id).toBe(originalSystemMessage?.id)
    expect(store.messages[0]?.createdAt).toBe(originalSystemMessage?.createdAt)
    expect(store.messages[0]?.content).toContain('Updated character prompt')
    expect(store.messages[0]?.content).not.toContain('Original character prompt')
    expect(store.messages[1]?.content).toBe('Keep this turn.')
  })

  // https://github.com/moeru-ai/airi/issues/1995
  it('hydrates a persisted Issue #1995 session before refreshing its system message', async () => {
    const meta: ChatSessionMeta = {
      sessionId: 'persisted-session',
      userId: 'local',
      characterId: 'default',
      createdAt: 1,
      updatedAt: 1,
    }
    getIndexMock.mockResolvedValue({
      userId: 'local',
      characters: {
        default: {
          activeSessionId: meta.sessionId,
          sessions: { [meta.sessionId]: meta },
        },
      },
    })

    let resolveStoredSession: ((record: ChatSessionRecord) => void) | undefined
    getSessionMock.mockImplementation(() => new Promise<ChatSessionRecord | null>((resolve) => {
      resolveStoredSession = resolve
    }))

    systemPromptRef.value = 'Updated persisted prompt'
    const store = useChatSessionStore()
    const initializePromise = store.initialize()
    await flushMicrotasks()

    // Updating the active session id must not persist a fresh system message
    // over history that has not finished loading from IndexedDB.
    expect(store.sessionMessages[meta.sessionId]).toBeUndefined()

    resolveStoredSession?.({
      meta,
      messages: [
        {
          role: 'system',
          content: 'Stale persisted prompt',
          id: 'system-message',
          createdAt: 1,
        },
        {
          role: 'user',
          content: 'Persisted history',
          id: 'user-message',
          createdAt: 2,
        },
      ],
    })
    await initializePromise
    await nextTick()

    expect(store.messages).toHaveLength(2)
    expect(store.messages[0]?.id).toBe('system-message')
    expect(store.messages[0]?.content).toContain('Updated persisted prompt')
    expect(store.messages[1]?.content).toBe('Persisted history')
  })
})

describe('chat-session-store · synchronized data actions', () => {
  // https://github.com/moeru-ai/airi/pull/2086#discussion_r3743242525
  it('initializes a new window selection from the synchronized index for Issue #2085', async () => {
    // ROOT CAUSE:
    //
    // `ready` was synchronized while selection was not. A joining window saw
    // the leader's ready flag, skipped initialization, and remained on an
    // empty local selection.
    const session: ChatSessionMeta = {
      sessionId: 'session-b',
      userId: 'local',
      characterId: 'default',
      createdAt: 1,
      updatedAt: 1,
    }
    const store = useChatSessionStore()
    store.$patch({
      sessionMessages: { 'session-b': [{ id: 'system', role: 'system', content: 'prompt' }] },
      sessionMetas: { 'session-b': session },
      index: {
        userId: 'local',
        characters: {
          default: {
            activeSessionId: 'session-b',
            sessions: { 'session-b': session },
          },
        },
      },
    })

    expect(store.$state).not.toHaveProperty('ready')
    expect(store.activeSessionId).toBe('')

    await store.initialize()

    expect(store.activeSessionId).toBe('session-b')
    expect(store.isReady).toBe(true)
    expect(getSessionMock).not.toHaveBeenCalled()
  })

  // https://github.com/moeru-ai/airi/issues/2595
  it('keeps the window-local selection when a synchronized index snapshot arrives for Issue #2595', async () => {
    // ROOT CAUSE: Shared index updates restored the previous selection after message submission. Window selection now changes only through explicit navigation or lifecycle transitions.
    const previousSession: ChatSessionMeta = {
      sessionId: 'session-previous',
      userId: 'local',
      characterId: 'default',
      createdAt: 1,
      updatedAt: 1,
    }
    const newSession: ChatSessionMeta = {
      sessionId: 'session-new',
      userId: 'local',
      characterId: 'default',
      createdAt: 2,
      updatedAt: 2,
    }
    const store = useChatSessionStore()
    store.$patch({
      sessionMessages: {
        'session-previous': [{ id: 'system-previous', role: 'system', content: 'prompt' }],
        'session-new': [{ id: 'system-new', role: 'system', content: 'prompt' }],
      },
      sessionMetas: {
        'session-previous': previousSession,
        'session-new': newSession,
      },
      index: {
        userId: 'local',
        characters: {
          default: {
            activeSessionId: 'session-previous',
            sessions: {
              'session-previous': previousSession,
              'session-new': newSession,
            },
          },
        },
      },
    })
    await store.initialize()
    await store.setActiveSession('session-new')

    store.index = store.getSnapshot().index
    await nextTick()

    expect(store.activeSessionId).toBe('session-new')
  })

  // https://github.com/moeru-ai/airi/pull/2086#discussion_r3743242529
  it('trusts synchronized messages instead of merging a stale follower IDB record for Issue #2085', async () => {
    // ROOT CAUSE:
    //
    // Follower hydration read its own older IndexedDB record and mutated the
    // fully synchronized store, allowing that stale snapshot to overwrite the
    // leader's newer messages or resurrect a deleted session.
    const session: ChatSessionMeta = {
      sessionId: 'session-b',
      userId: 'local',
      characterId: 'default',
      createdAt: 1,
      updatedAt: 2,
    }
    getSessionMock.mockResolvedValue({
      meta: { ...session, updatedAt: 1 },
      messages: [{ id: 'stale', role: 'user', content: 'stale follower data' }],
    })
    const store = useChatSessionStore()
    store.$patch({
      sessionMessages: {
        'session-b': [{ id: 'current', role: 'assistant', content: 'leader data', slices: [], tool_results: [] }],
      },
      sessionMetas: { 'session-b': session },
    })

    await expect(store.loadSession('session-b')).resolves.toBe(true)

    expect(getSessionMock).not.toHaveBeenCalled()
    expect(store.getSessionMessagesIfLoaded('session-b')?.map(message => message.id)).toEqual(['current'])
  })

  it('refreshes an already loaded session from IndexedDB for a completed remote stream', async () => {
    const session: ChatSessionMeta = {
      sessionId: 'session-b',
      userId: 'local',
      characterId: 'default',
      createdAt: 1,
      updatedAt: 2,
    }
    const store = useChatSessionStore()
    store.applyRemoteSnapshot({
      activeSessionId: 'session-b',
      sessionMessages: { 'session-b': [{ id: 'system', role: 'system', content: 'prompt' }] },
      sessionMetas: { 'session-b': session },
      index: {
        userId: 'local',
        characters: {
          default: {
            activeSessionId: 'session-b',
            sessions: { 'session-b': session },
          },
        },
      },
    })
    getSessionMock.mockResolvedValue({
      meta: session,
      messages: [
        { id: 'system', role: 'system', content: 'prompt' },
        { id: 'assistant', role: 'assistant', content: 'complete answer', slices: [], tool_results: [] },
      ],
    })

    await expect(store.refreshSession('session-b')).resolves.toBe(true)

    expect(getSessionMock).toHaveBeenCalledWith('session-b')
    expect(store.getSessionMessages('session-b').map(message => message.id)).toEqual(['system', 'assistant'])
  })

  // https://github.com/moeru-ai/airi/pull/2086#discussion_r3743121862
  it('moves a follower away from a session removed by another window for Issue #2085', async () => {
    // ROOT CAUSE:
    //
    // Synchronized deletion removed B's metadata, but activeSessionId is
    // intentionally window-local. A follower that also selected B therefore
    // kept an invalid selection until it manually chose another session.
    const sessionA: ChatSessionMeta = {
      sessionId: 'session-a',
      userId: 'local',
      characterId: 'default',
      createdAt: 1,
      updatedAt: 1,
    }
    const sessionB: ChatSessionMeta = {
      sessionId: 'session-b',
      userId: 'local',
      characterId: 'default',
      createdAt: 2,
      updatedAt: 2,
    }
    const store = useChatSessionStore()
    store.applyRemoteSnapshot({
      activeSessionId: 'session-b',
      sessionMessages: { 'session-a': [], 'session-b': [] },
      sessionMetas: { 'session-a': sessionA, 'session-b': sessionB },
      index: {
        userId: 'local',
        characters: {
          default: {
            activeSessionId: 'session-a',
            sessions: { 'session-a': sessionA, 'session-b': sessionB },
          },
        },
      },
    })
    await nextTick()

    store.applyRemoteSnapshot({
      activeSessionId: 'session-b',
      sessionMessages: { 'session-a': [] },
      sessionMetas: { 'session-a': sessionA },
      index: {
        userId: 'local',
        characters: {
          default: {
            activeSessionId: 'session-a',
            sessions: { 'session-a': sessionA },
          },
        },
      },
    })
    await nextTick()

    expect(store.activeSessionId).toBe('session-a')
  })

  // https://github.com/moeru-ai/airi/pull/2086#discussion_r3743221033
  it('waits for the leader replacement when every window loses its last session for Issue #2085', async () => {
    // ROOT CAUSE:
    //
    // Every follower independently created a replacement when synchronized
    // deletion temporarily left no metadata. Multiple windows could therefore
    // turn one deletion into several empty chats before state converged.
    const removedSession: ChatSessionMeta = {
      sessionId: 'session-b',
      userId: 'local',
      characterId: 'default',
      createdAt: 1,
      updatedAt: 1,
    }
    const replacementSession: ChatSessionMeta = {
      sessionId: 'session-c',
      userId: 'local',
      characterId: 'default',
      createdAt: 2,
      updatedAt: 2,
    }
    const store = useChatSessionStore()
    store.applyRemoteSnapshot({
      activeSessionId: 'session-b',
      sessionMessages: { 'session-b': [] },
      sessionMetas: { 'session-b': removedSession },
      index: {
        userId: 'local',
        characters: {
          default: {
            activeSessionId: 'session-b',
            sessions: { 'session-b': removedSession },
          },
        },
      },
    })
    await nextTick()
    saveSessionMock.mockClear()

    store.applyRemoteSnapshot({
      activeSessionId: 'session-b',
      sessionMessages: {},
      sessionMetas: {},
      index: { userId: 'local', characters: {} },
    })
    await nextTick()

    expect(saveSessionMock).not.toHaveBeenCalled()
    expect(store.activeSessionId).toBe('session-b')

    store.applyRemoteSnapshot({
      activeSessionId: 'session-b',
      sessionMessages: { 'session-c': [] },
      sessionMetas: { 'session-c': replacementSession },
      index: {
        userId: 'local',
        characters: {
          default: {
            activeSessionId: 'session-c',
            sessions: { 'session-c': replacementSession },
          },
        },
      },
    })
    await nextTick()

    expect(store.activeSessionId).toBe('session-c')
  })

  it('deletes a message by its stable id from the specified session', async () => {
    const store = useChatSessionStore()
    store.applyRemoteSnapshot({
      activeSessionId: 'session-1',
      sessionMessages: {
        'session-1': [
          { id: 'keep', role: 'user', content: 'keep' },
          { id: 'delete', role: 'assistant', content: 'delete', slices: [], tool_results: [] },
        ],
      },
      sessionMetas: {},
    })

    await store.deleteMessage({
      sessionId: 'session-1',
      messageId: 'delete',
    })

    expect(store.getSessionMessages('session-1').map(message => message.id)).toEqual(['keep'])
  })

  it('releases the assets of a deleted message that no other message references', async () => {
    const store = useChatSessionStore()
    const recording = (id: string) => ({ type: 'input_audio' as const, input_audio: { data: `airi-asset:${id}`, format: 'wav' as const } })
    store.applyRemoteSnapshot({
      activeSessionId: 'session-1',
      sessionMessages: {
        'session-1': [
          { id: 'keep', role: 'user', content: [recording('shared')] },
          { id: 'delete', role: 'user', content: [recording('shared'), recording('only-here'), { type: 'image_url', image_url: { url: 'airi-asset:image' } }] },
        ],
      },
      sessionMetas: {},
    })

    await store.deleteMessage({ sessionId: 'session-1', messageId: 'delete' })

    expect(releaseAssetsMock).toHaveBeenCalledTimes(1)
    expect([...releaseAssetsMock.mock.calls[0][1]].sort()).toEqual(['image', 'only-here'])
    expect(releaseAssetsMock.mock.calls[0][0]).toBe('session-1')
  })

  it('keeps window-local selection out of synchronized and persisted session state', async () => {
    const store = useChatSessionStore()
    store.applyRemoteSnapshot({
      activeSessionId: 'persisted-session',
      index: {
        userId: 'local',
        characters: {
          default: {
            activeSessionId: 'persisted-session',
            sessions: {},
          },
        },
      },
      sessionMessages: {
        'window-local-session': [{ id: 'system', role: 'system', content: 'prompt' }],
      },
      sessionMetas: {},
    })

    await store.setActiveSession('window-local-session')

    expect(store.activeSessionId).toBe('window-local-session')
    expect(store.$state).not.toHaveProperty('activeSessionId')
    expect(store.getSnapshot().index?.characters.default?.activeSessionId).toBe('persisted-session')
  })
})
