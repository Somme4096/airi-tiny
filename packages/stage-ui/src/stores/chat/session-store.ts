import type {} from 'pinia-plugin-synced'

import type { ChatHistoryItem } from '../../types/chat'
import type { ChatSessionMeta, ChatSessionRecord, ChatSessionsExport, ChatSessionsIndex, ChatSessionTask, StoredVoiceInterruption } from '../../types/chat-session'

import { errorMessageFrom } from '@moeru/std'
import { cloneDeep } from 'es-toolkit'
import { nanoid } from 'nanoid'
import { defineStore, storeToRefs } from 'pinia'
import { computed, ref, watch } from 'vue'

import { chatSessionsRepo } from '../../database/repos/chat-sessions.repo'
import { chatAssetIdsOf, inlineChatAssets } from '../../libs/chat-assets'
import { captureAnalyticsEvent } from '../../libs/product-signals'
import { useAiriCardStore } from '../modules/airi-card'
import { mergeLoadedSessionMessages } from './session-message-merge'

/** Identifies one message that must be removed from a session. */
export interface DeleteChatMessagePayload {
  index?: number
  messageId?: string
  sessionId: string
}

/**
 * Owner id in every stored index and session.
 * Chat history has one owner, the device. The storage keys and the export format keep the owner field.
 */
const LOCAL_USER_ID = 'local'

const useChatSessionSelectionStore = defineStore('chat-session-selection', () => {
  const activeSessionId = ref('')

  return { activeSessionId }
})

export const useChatSessionStore = defineStore('chat-session', () => {
  const cards = useAiriCardStore()
  const { activeCardId } = storeToRefs(cards)

  const chatSessionSelection = useChatSessionSelectionStore()
  // The selected conversation belongs to one window. Expose it through the
  // existing chat-session API as a computed property so synchronized session
  // data never makes another window navigate to the same conversation.
  const activeSessionId = computed({
    get: () => chatSessionSelection.activeSessionId,
    set: value => chatSessionSelection.activeSessionId = value,
  })
  const sessionMessages = ref<Record<string, ChatHistoryItem[]>>({})
  const sessionMetas = ref<Record<string, ChatSessionMeta>>({})
  const sessionGenerations = ref<Record<string, number>>({})
  /** Canonical session index replicated so each window can derive its local selection. */
  const index = ref<ChatSessionsIndex | null>(null)

  const ready = ref(false)
  const isReady = computed(() => ready.value)
  const initializing = ref(false)
  let initializePromise: Promise<void> | null = null
  let ensureActivePromise: Promise<string> | null = null
  const characterSessionRequests = new Map<string, Promise<string>>()

  let persistQueue = Promise.resolve()
  const loadedSessions = new Set<string>()
  const staleSessions = new Set<string>()
  const loadingSessions = new Map<string, Promise<boolean>>()

  function getCurrentCharacterId() {
    return activeCardId.value || 'default'
  }

  /**
   * Append a write task to the persist queue. Tasks always run sequentially
   * regardless of whether prior tasks rejected — but rejections propagate to
   * the awaiting caller AND are surfaced via console for debugging. The
   * previous `then(task, task)` form silently swallowed prior rejections by
   * running the next task as the rejection handler, which masked IDB
   * failures.
   */
  function enqueuePersist<T>(task: () => Promise<T>): Promise<T> {
    const next = persistQueue.then(task)
    // Keep the queue alive after a rejection but log it so silent IDB
    // failures (quota, corruption) surface during dev.
    persistQueue = next.then(
      () => undefined,
      (err) => {
        console.warn('[chat-session] persist task failed:', errorMessageFrom(err))
      },
    )
    return next
  }

  function snapshotMessages(messages: ChatHistoryItem[]) {
    return cloneDeep(messages)
  }

  function ensureSessionMessageIds(sessionId: string) {
    const current = sessionMessages.value[sessionId] ?? []
    let changed = false
    const next = current.map((message) => {
      if (message.id)
        return message
      changed = true
      return {
        ...message,
        id: nanoid(),
      }
    })

    if (changed)
      sessionMessages.value[sessionId] = next

    return next
  }

  function ensureGeneration(sessionId: string) {
    if (sessionGenerations.value[sessionId] === undefined)
      sessionGenerations.value[sessionId] = 0
  }

  async function loadIndex() {
    const stored = await chatSessionsRepo.getIndex(LOCAL_USER_ID)
    index.value = stored ?? {
      userId: LOCAL_USER_ID,
      characters: {},
    }
    // Hydrate `sessionMetas` from the index so consumers like the sessions
    // drawer can list every owned session without having to `loadSession`
    // each one (which would pull every messages payload from IndexedDB).
    // Existing entries win to preserve any in-memory mutations the store
    // performed before the index landed.
    if (index.value) {
      for (const character of Object.values(index.value.characters)) {
        for (const [sessionId, meta] of Object.entries(character.sessions)) {
          if (!sessionMetas.value[sessionId])
            sessionMetas.value[sessionId] = meta
        }
      }
    }
  }

  function getCharacterIndex(characterId: string) {
    if (!index.value)
      return null
    return index.value.characters[characterId] ?? null
  }

  async function persistIndex() {
    if (!index.value)
      return
    const snapshot = cloneDeep(index.value)
    await enqueuePersist(() => chatSessionsRepo.saveIndex(snapshot))
  }

  async function persistSession(sessionId: string) {
    await enqueuePersist(async () => {
      const meta = sessionMetas.value[sessionId]
      if (!meta)
        return

      const messages = snapshotMessages(ensureSessionMessageIds(sessionId))
      const now = Date.now()
      // Nested meta fields, such as the bindings, are reactive proxies. IndexedDB cannot clone them, so the record stores a plain copy.
      const updatedMeta = {
        ...cloneDeep(meta),
        updatedAt: now,
      }

      sessionMetas.value[sessionId] = updatedMeta
      const characterIndex = index.value?.characters[meta.characterId]
      if (characterIndex)
        characterIndex.sessions[sessionId] = updatedMeta

      const record: ChatSessionRecord = {
        meta: updatedMeta,
        messages,
      }

      await chatSessionsRepo.saveSession(sessionId, record)

      if (index.value) {
        const snapshot = cloneDeep(index.value)
        await chatSessionsRepo.saveIndex(snapshot)
      }
    })
  }

  function persistSessionMessages(sessionId: string) {
    return persistSession(sessionId)
  }

  function replaceSessionMessages(sessionId: string, next: ChatHistoryItem[], options?: { persist?: boolean }) {
    sessionMessages.value[sessionId] = next

    if (options?.persist !== false)
      void persistSession(sessionId)
  }

  function setSessionMessages(sessionId: string, next: ChatHistoryItem[]) {
    replaceSessionMessages(sessionId, next)
  }

  function appendSessionMessage(sessionId: string, message: ChatHistoryItem) {
    ensureSession(sessionId)
    replaceSessionMessages(sessionId, [
      ...(sessionMessages.value[sessionId] ?? []),
      message,
    ])
  }

  /** Acknowledge a user message only after storage succeeds. Retries use its stable identity. */
  async function commitUserMessage(sessionId: string, message: Extract<ChatHistoryItem, { role: 'user' }> & { id: string }) {
    if (!sessionMetas.value[sessionId])
      throw new Error('Cannot commit a message to an unknown session')
    const generation = getSessionGeneration(sessionId)
    const messages = ensureSessionMessageIds(sessionId)
    const existing = messages.find(item => item.id === message.id)
    if (existing && existing.role !== 'user')
      throw new Error('Message identity belongs to another message type')
    if (!existing)
      replaceSessionMessages(sessionId, [...messages, message], { persist: false })
    try {
      await persistSession(sessionId)
      if (getSessionGeneration(sessionId) !== generation || !sessionMetas.value[sessionId]
        || !sessionMessages.value[sessionId]?.some(item => item.id === message.id)) {
        throw new Error('Chat session changed before message persistence completed')
      }
    }
    catch (error) {
      if (!existing) {
        const current = sessionMessages.value[sessionId]
        if (current)
          replaceSessionMessages(sessionId, current.filter(item => item.id !== message.id), { persist: false })
      }
      throw error
    }
    return { status: existing ? 'existing' as const : 'inserted' as const, messageId: message.id }
  }

  /** Persists a control event under its turn's session. Retries retain the original event identity. */
  async function recordInterruption(event: StoredVoiceInterruption) {
    const sessionId = event.turn.sessionId
    if (!await loadSession(sessionId))
      throw new Error('Cannot record interruption for an unknown session')
    const generation = getSessionGeneration(sessionId)
    const meta = sessionMetas.value[sessionId]
    if (!meta.controlEvents?.some(record => record.eventId === event.eventId))
      meta.controlEvents = [...(meta.controlEvents ?? []), event]
    await persistSession(sessionId)
    if (generation !== getSessionGeneration(sessionId) || !sessionMetas.value[sessionId])
      throw new Error('Session changed before interruption persistence completed')
    return { status: 'queued' as const }
  }

  /** Removes one message by stable id or by its current history index. */
  async function deleteMessage(payload: DeleteChatMessagePayload): Promise<void> {
    if (!await loadSession(payload.sessionId))
      throw new Error('Failed to load the target chat session')

    const currentMessages = getSessionMessages(payload.sessionId)
    const nextMessages = currentMessages.filter((message, messageIndex) => {
      if (payload.messageId)
        return message.id !== payload.messageId
      if (payload.index !== undefined)
        return messageIndex !== payload.index
      return true
    })

    setSessionMessages(payload.sessionId, nextMessages)
    await releaseRemovedAssets(payload.sessionId, currentMessages, nextMessages)
  }

  /**
   * Releases the images and recordings that `previous` referenced and `next` no longer does.
   * The release queues after the save of `next`, so a stored message never references a deleted asset.
   */
  async function releaseRemovedAssets(sessionId: string, previous: readonly ChatHistoryItem[], next: readonly ChatHistoryItem[]) {
    const kept = chatAssetIdsOf(next)
    const removed = [...chatAssetIdsOf(previous)].filter(id => !kept.has(id))
    if (removed.length)
      await enqueuePersist(() => chatSessionsRepo.releaseAssets(sessionId, removed))
  }

  /**
   * Hydrate a single session's messages from IDB into memory. Idempotent —
   * subsequent calls for the same id are no-ops.
   *
   * Use when:
   * - The drawer is opening, the user is switching to a session, or any
   *   caller needs the full message list (not just the meta record).
   *
   * Expects:
   * - `sessionId` exists either in `sessionMetas` or in IDB.
   *
   * Returns:
   * - `true` when the session is in memory, or `false` when hydration failed.
   *   On IDB error, removes the id
   *   from the loading map so subsequent calls can retry rather than wedge
   *   on a stale promise. Errors are intentionally not rethrown — the
   *   failing session is simply absent from local state and the next
   *   loadSession call will retry.
   */
  async function loadSession(sessionId: string): Promise<boolean> {
    if (loadedSessions.has(sessionId) && !staleSessions.has(sessionId)) {
      return true
    }
    // A synchronized snapshot already carries the canonical hydrated
    // messages. Trust it instead of letting this follower merge an older IDB
    // record and publish that stale full-store proposal back to the leader.
    if (Object.hasOwn(sessionMessages.value, sessionId) && hasKnownSession(sessionId) && !staleSessions.has(sessionId)) {
      loadedSessions.add(sessionId)
      return true
    }
    if (loadingSessions.has(sessionId)) {
      return await loadingSessions.get(sessionId)!
    }

    const loadPromise = (async () => {
      try {
        if (!loadedSessions.has(sessionId) || staleSessions.has(sessionId)) {
          const stored = await chatSessionsRepo.getSession(sessionId)
          // Re-check existence after the IDB read. Deletion or an account
          // change can remove this session while the read is pending.
          if (!sessionMetas.value[sessionId])
            return false
          if (staleSessions.has(sessionId) && !stored)
            return false
          if (stored) {
            const currentMessages = sessionMessages.value[sessionId] ?? []
            const mergedMessages = mergeLoadedSessionMessages(stored.messages, currentMessages)

            sessionMetas.value[sessionId] = stored.meta
            replaceSessionMessages(sessionId, mergedMessages, { persist: false })
            ensureGeneration(sessionId)

            if (mergedMessages !== stored.messages)
              await persistSession(sessionId)
          }
          staleSessions.delete(sessionId)
          loadedSessions.add(sessionId)
        }

        // Missing IDB payloads still need a valid canonical conversation.
        // This action runs in the elected leader, so the initialized history
        // is published once rather than independently by every follower.
        ensureSession(sessionId)

        return true
      }
      catch (err) {
        // Do NOT add to loadedSessions on failure — the next call should
        // retry rather than fast-return on stale "already loaded" state.
        console.warn('[chat-session] loadSession failed for', sessionId, errorMessageFrom(err))
        return false
      }
    })()

    loadingSessions.set(sessionId, loadPromise)
    try {
      return await loadPromise
    }
    finally {
      // Always drain the loading map so a transient failure does not leave
      // a permanent wedge entry.
      loadingSessions.delete(sessionId)
    }
  }

  /** Forces the next session load to merge the latest IndexedDB record into memory. */
  async function refreshSession(sessionId: string): Promise<boolean> {
    staleSessions.add(sessionId)
    loadedSessions.delete(sessionId)
    return loadSession(sessionId)
  }

  /**
   * Mint a new session for `characterId`, optionally seeding it with messages
   * and / or a title. Persists the new session and its index entry.
   *
   * Use when:
   * - The drawer's "+ New" button fires, the active card changes and the
   *   user has no session for that card yet, or `forkSession` needs a new
   *   destination.
   *
   * Expects:
   * - The store is initialized (or being initialized via `initialize()`).
   *
   * Returns:
   * - The new session id. When `setActive` is not `false` the session is
   *   also made the active one.
   */
  async function createSession(characterId: string, options?: {
    setActive?: boolean
    messages?: ChatHistoryItem[]
    title?: string
    bindings?: string[]
    parentSessionId?: string
    hidden?: boolean
    recipeId?: string
    task?: ChatSessionTask
  }) {
    const sessionId = nanoid()
    const now = Date.now()
    const meta: ChatSessionMeta = {
      sessionId,
      userId: LOCAL_USER_ID,
      characterId,
      title: options?.title,
      // A caller can pass reactive bindings, such as a parent session's. IndexedDB stores only a plain copy.
      bindings: options?.bindings ? [...options.bindings] : undefined,
      parentSessionId: options?.parentSessionId,
      hidden: options?.hidden,
      recipeId: options?.recipeId,
      task: options?.task ? { ...options.task } : undefined,
      createdAt: now,
      updatedAt: now,
    }

    const initialMessages = options?.messages?.length ? cloneDeep(options.messages) : []

    sessionMetas.value[sessionId] = meta
    replaceSessionMessages(sessionId, initialMessages, { persist: false })
    loadedSessions.add(sessionId)
    ensureGeneration(sessionId)

    if (!index.value)
      index.value = { userId: LOCAL_USER_ID, characters: {} }

    const characterIndex = index.value.characters[characterId] ?? {
      activeSessionId: sessionId,
      sessions: {},
    }
    characterIndex.sessions[sessionId] = meta
    if (options?.setActive !== false)
      characterIndex.activeSessionId = sessionId
    index.value.characters[characterId] = characterIndex

    const record: ChatSessionRecord = { meta, messages: initialMessages }
    await enqueuePersist(() => chatSessionsRepo.saveSession(sessionId, record))
    await persistIndex()

    if (options?.setActive !== false)
      activeSessionId.value = sessionId

    captureAnalyticsEvent('conversation_created', {
      conversation_id: sessionId,
      source: options?.messages?.length ? 'fork' : 'new_session',
      character_id: characterId,
    })

    return sessionId
  }

  /** Permanently removes a session and the assets that only this session owns. */
  async function deleteSession(sessionId: string) {
    // Keep a monotonic tombstone in memory so queued and streaming sends that
    // captured the previous generation cannot become current again after the
    // session record is removed.
    bumpSessionGeneration(sessionId)

    const meta = sessionMetas.value[sessionId]
    if (!meta)
      return

    // Snapshot count before the in-memory wipe below zeroes it out.
    const messageCount = (sessionMessages.value[sessionId] ?? []).length
    captureAnalyticsEvent('chat_session_deleted', {
      session_id: sessionId,
      message_count: messageCount,
    })
    captureAnalyticsEvent('conversation_deleted', {
      conversation_id: sessionId,
      message_count: messageCount,
    })

    const wasActive = activeSessionId.value === sessionId
    const characterId = meta.characterId

    delete sessionMetas.value[sessionId]
    delete sessionMessages.value[sessionId]
    loadedSessions.delete(sessionId)
    staleSessions.delete(sessionId)
    loadingSessions.delete(sessionId)

    if (index.value) {
      const characterIndex = index.value.characters[characterId]
      if (characterIndex) {
        delete characterIndex.sessions[sessionId]
        if (characterIndex.activeSessionId === sessionId)
          characterIndex.activeSessionId = ''
      }
    }

    await enqueuePersist(() => chatSessionsRepo.deleteSession(sessionId))
    await persistIndex()

    const characterIndex = index.value?.characters[characterId]
    // A hidden session, such as a background task's own space, never becomes the selected conversation.
    const fallbackId = characterIndex
      ? Object.keys(characterIndex.sessions).find(id => sessionMetas.value[id] && !sessionMetas.value[id].hidden)
      : undefined

    // Persisted character fallback is shared, but live selection is local to
    // the window that was displaying the deleted session.
    if (fallbackId && characterIndex) {
      characterIndex.activeSessionId = fallbackId
      if (wasActive) {
        activeSessionId.value = fallbackId
        await loadSession(fallbackId)
      }
      await persistIndex()
      return
    }

    const replacementSessionId = await createSession(characterId, { setActive: wasActive })
    if (!wasActive) {
      // The synchronized leader may be displaying a different character, but
      // this replacement is still the canonical fallback for the character
      // whose final session was deleted. Persist that index choice without
      // navigating the leader's window-local selection.
      const replacementCharacterIndex = index.value?.characters[characterId]
      if (replacementCharacterIndex) {
        replacementCharacterIndex.activeSessionId = replacementSessionId
        await persistIndex()
      }
    }
  }

  /**
   * Load the index, pick (or mint) the active session for the
   * current character, and hydrate it into memory. Reentrant: concurrent
   * callers share a single in-flight promise so a rapid character
   * change burst does not produce duplicate sessions.
   */
  async function ensureActiveSessionForCharacter(): Promise<string> {
    if (ensureActivePromise)
      return ensureActivePromise
    ensureActivePromise = (async () => {
      const characterId = getCurrentCharacterId()

      if (!index.value)
        await loadIndex()

      const characterIndex = getCharacterIndex(characterId)
      if (!characterIndex)
        return createSession(characterId)

      if (!characterIndex.activeSessionId)
        return createSession(characterId)

      activeSessionId.value = characterIndex.activeSessionId
      // Use the public action so follower hydration is routed to the elected
      // leader instead of becoming a stale full-state proposal.
      await useChatSessionStore().loadSession(characterIndex.activeSessionId)
      return characterIndex.activeSessionId
    })()
    try {
      return await ensureActivePromise
    }
    finally {
      ensureActivePromise = null
    }
  }

  /**
   * Resolves the canonical session of the current character.
   * The synchronization plugin routes this action to one renderer.
   */
  async function ensureCurrentSession(): Promise<string> {
    return ensureActiveSessionForCharacter()
  }

  /** Wake routing resolves a character's conversation without navigating any window or draft. */
  async function ensureCharacterSession(characterId: string): Promise<string> {
    if (!ready.value || !index.value)
      throw new Error('Chat sessions are not ready')
    if (!cards.getCard(characterId))
      throw new Error('The requested character is unavailable')
    const existing = characterSessionRequests.get(characterId)
    if (existing)
      return existing
    const pending = (async () => {
      const sessionId = getCharacterIndex(characterId)?.activeSessionId ?? await createSession(characterId, { setActive: false })
      if (!await loadSession(sessionId))
        throw new Error('Failed to load the character session')
      return sessionId
    })()
    characterSessionRequests.set(characterId, pending)
    try {
      return await pending
    }
    finally {
      if (characterSessionRequests.get(characterId) === pending)
        characterSessionRequests.delete(characterId)
    }
  }

  async function initialize() {
    if (ready.value) {
      return
    }
    if (initializePromise) {
      return initializePromise
    }
    initializing.value = true
    initializePromise = (async () => {
      const sessionId = await useChatSessionStore().ensureCurrentSession()
      if (sessionId)
        activeSessionId.value = sessionId
      else
        selectWindowSessionFromIndex()

      ready.value = true
    })()

    try {
      await initializePromise
    }
    finally {
      initializePromise = null
      initializing.value = false
    }
  }

  function ensureSession(sessionId: string) {
    ensureGeneration(sessionId)
    if (!sessionMessages.value[sessionId] || sessionMessages.value[sessionId].length === 0) {
      replaceSessionMessages(sessionId, [], { persist: false })
    }
  }

  function hasKnownSession(sessionId: string) {
    return !!sessionMetas.value[sessionId]
      || !!Object.values(index.value?.characters ?? {}).some(character => character.sessions[sessionId])
  }

  /** Selects the persisted session for this window without changing synchronized session data. */
  function selectWindowSessionFromIndex() {
    activeSessionId.value = getCharacterIndex(getCurrentCharacterId())?.activeSessionId ?? ''
  }

  const messages = computed<ChatHistoryItem[]>({
    get: () => {
      if (!activeSessionId.value) {
        return []
      }
      if (!loadedSessions.has(activeSessionId.value) && !sessionMessages.value[activeSessionId.value] && hasKnownSession(activeSessionId.value)) {
        return []
      }
      return sessionMessages.value[activeSessionId.value] ?? []
    },
    set: (value) => {
      if (!activeSessionId.value)
        return
      replaceSessionMessages(activeSessionId.value, value)
    },
  })

  /** Selects and hydrates one conversation only in the current window. */
  async function setActiveSession(sessionId: string) {
    activeSessionId.value = sessionId

    if (ready.value)
      await useChatSessionStore().loadSession(sessionId)
    else if (!hasKnownSession(sessionId))
      ensureSession(sessionId)
  }

  function applyRemoteSnapshot(snapshot: {
    activeSessionId: string
    sessionMessages: Record<string, ChatHistoryItem[]>
    sessionMetas: Record<string, ChatSessionMeta>
    index?: ChatSessionsIndex | null
  }) {
    activeSessionId.value = snapshot.activeSessionId
    sessionMessages.value = cloneDeep(snapshot.sessionMessages)
    sessionMetas.value = cloneDeep(snapshot.sessionMetas)
    if (snapshot.index !== undefined) {
      index.value = cloneDeep(snapshot.index)
    }
    sessionGenerations.value = Object.fromEntries(
      Object.keys(snapshot.sessionMessages).map(sessionId => [sessionId, sessionGenerations.value[sessionId] ?? 0]),
    )
    loadedSessions.clear()
    staleSessions.clear()
    for (const sessionId of Object.keys(snapshot.sessionMessages)) {
      loadedSessions.add(sessionId)
    }
  }

  function getSnapshot() {
    return {
      activeSessionId: activeSessionId.value,
      sessionMessages: cloneDeep(sessionMessages.value),
      sessionMetas: cloneDeep(sessionMetas.value),
      index: cloneDeep(index.value),
    }
  }

  function cleanupMessages(sessionId = activeSessionId.value) {
    ensureGeneration(sessionId)
    sessionGenerations.value[sessionId] += 1
    const previous = sessionMessages.value[sessionId] ?? []
    setSessionMessages(sessionId, [])
    void releaseRemovedAssets(sessionId, previous, [])
  }

  function getAllSessions() {
    return cloneDeep(sessionMessages.value)
  }

  async function resetAllSessions() {
    const characterId = getCurrentCharacterId()
    const sessionIds = new Set<string>()

    for (const character of Object.values(index.value?.characters ?? {})) {
      for (const sessionId of Object.keys(character.sessions))
        sessionIds.add(sessionId)
    }

    for (const sessionId of sessionIds)
      await enqueuePersist(() => chatSessionsRepo.deleteSession(sessionId))

    sessionMessages.value = {}
    sessionMetas.value = {}
    sessionGenerations.value = {}
    loadedSessions.clear()
    staleSessions.clear()
    loadingSessions.clear()

    index.value = {
      userId: LOCAL_USER_ID,
      characters: {},
    }

    await createSession(characterId)
  }

  function getSessionMessages(sessionId: string) {
    ensureSession(sessionId)
    return sessionMessages.value[sessionId] ?? []
  }

  /** Returns persisted/in-memory messages without creating an unloaded session fallback. */
  function getSessionMessagesIfLoaded(sessionId: string) {
    return sessionMessages.value[sessionId]
  }

  function getSessionGeneration(sessionId: string) {
    ensureGeneration(sessionId)
    return sessionGenerations.value[sessionId] ?? 0
  }

  function bumpSessionGeneration(sessionId: string) {
    ensureGeneration(sessionId)
    sessionGenerations.value[sessionId] += 1
    return sessionGenerations.value[sessionId]
  }

  function getSessionGenerationValue(sessionId?: string) {
    const target = sessionId ?? activeSessionId.value
    return getSessionGeneration(target)
  }

  /**
   * Recovers one external scene without changing the window's selected conversation.
   * Only a root session of the scene can serve it. Otherwise the scene starts a new session.
   */
  async function ensureBoundSession(binding: string): Promise<string> {
    if (!binding.trim())
      throw new Error('An external session binding must not be empty')
    if (!ready.value)
      await initialize()

    const characterId = getCurrentCharacterId()
    const existing = Object.values(sessionMetas.value)
      .filter(meta => meta.characterId === characterId && !meta.parentSessionId
        && meta.bindings?.includes(binding))
      .sort((left, right) => right.updatedAt - left.updatedAt)[0]
    if (existing) {
      if (!await loadSession(existing.sessionId))
        throw new Error('Failed to recover the bound chat session')
      return existing.sessionId
    }

    return createSession(characterId, { setActive: false, bindings: [binding] })
  }

  /**
   * Records the status of the background task that a session runs, in the session record and the index.
   * With `from`, the change applies only while the task is in one of those statuses. The check and the write run in one step after loading, so two changes never overwrite each other.
   *
   * Returns:
   * - Whether the change applied. False when the session is gone, cannot load, or left the expected statuses.
   */
  async function setSessionTask(sessionId: string, change: Partial<ChatSessionTask>, from?: ChatSessionTask['status'][]) {
    if (!sessionMetas.value[sessionId] || !await loadSession(sessionId))
      return false
    const meta = sessionMetas.value[sessionId]
    if (!meta?.task || (from && !from.includes(meta.task.status)))
      return false
    sessionMetas.value[sessionId] = { ...meta, task: { ...meta.task, ...change } }
    await persistSession(sessionId)
    return true
  }

  /**
   * Deletes a hidden session, such as a finished background task.
   * Unlike {@link deleteSession}, it never moves a character's selected conversation and never creates a replacement, because nobody selects a hidden session.
   */
  async function deleteHiddenSession(sessionId: string) {
    const meta = sessionMetas.value[sessionId]
    if (!meta?.hidden)
      return false
    bumpSessionGeneration(sessionId)
    delete sessionMetas.value[sessionId]
    delete sessionMessages.value[sessionId]
    loadedSessions.delete(sessionId)
    staleSessions.delete(sessionId)
    loadingSessions.delete(sessionId)
    const characterIndex = index.value?.characters[meta.characterId]
    if (characterIndex)
      delete characterIndex.sessions[sessionId]
    await enqueuePersist(() => chatSessionsRepo.deleteSession(sessionId))
    await persistIndex()
    return true
  }

  async function forkSession(options: { fromSessionId: string, atIndex?: number, reason?: string, hidden?: boolean }) {
    if (!await loadSession(options.fromSessionId))
      throw new Error('Failed to load the parent chat session')
    const parentMeta = sessionMetas.value[options.fromSessionId]
    const characterId = parentMeta.characterId
    const parentMessages = getSessionMessages(options.fromSessionId)
    const forkIndex = options.atIndex ?? parentMessages.length
    const nextMessages = parentMessages.slice(0, forkIndex)
    // A branch keeps its parent's scene. Recovery never treats it as the scene's root session.
    return await createSession(characterId, {
      setActive: false,
      messages: nextMessages,
      bindings: parentMeta.bindings,
      parentSessionId: options.fromSessionId,
      hidden: options.hidden,
    })
  }

  async function exportSessions(): Promise<ChatSessionsExport> {
    if (!ready.value)
      await initialize()

    if (!index.value) {
      return {
        format: 'chat-sessions-index:v1',
        index: { userId: LOCAL_USER_ID, characters: {} },
        sessions: {},
      }
    }

    const sessions: Record<string, ChatSessionRecord> = {}
    for (const character of Object.values(index.value.characters)) {
      for (const sessionId of Object.keys(character.sessions)) {
        // An export leaves the device, so it carries the bytes of each image and recording in place of asset references.
        const stored = await chatSessionsRepo.getSession(sessionId)
        if (stored) {
          sessions[sessionId] = { ...stored, messages: await inlineChatAssets(stored.messages) }
          continue
        }
        const meta = sessionMetas.value[sessionId]
        const messages = sessionMessages.value[sessionId]
        if (meta && messages)
          sessions[sessionId] = { meta, messages: await inlineChatAssets(messages) }
      }
    }

    return {
      format: 'chat-sessions-index:v1',
      index: cloneDeep(index.value),
      sessions: cloneDeep(sessions),
    }
  }

  async function importSessions(payload: ChatSessionsExport) {
    if (payload.format !== 'chat-sessions-index:v1')
      return

    // An export can come from an installation that stored another owner id. This device owns the imported history.
    const importedIndex: ChatSessionsIndex = { ...cloneDeep(payload.index), userId: LOCAL_USER_ID }
    index.value = importedIndex
    sessionMessages.value = {}
    sessionMetas.value = {}
    sessionGenerations.value = {}
    loadedSessions.clear()
    staleSessions.clear()
    loadingSessions.clear()

    await enqueuePersist(() => chatSessionsRepo.saveIndex(cloneDeep(importedIndex)))

    for (const [sessionId, record] of Object.entries(payload.sessions)) {
      sessionMetas.value[sessionId] = cloneDeep(record.meta)
      sessionMessages.value[sessionId] = cloneDeep(record.messages)
      ensureGeneration(sessionId)
      await enqueuePersist(() => chatSessionsRepo.saveSession(sessionId, {
        meta: cloneDeep(record.meta),
        messages: cloneDeep(record.messages),
      }))
    }

    await ensureActiveSessionForCharacter()
  }

  let lastActiveSessionMeta: ChatSessionMeta | undefined

  // Session data is synchronized, but selection belongs to this window. If
  // another window deletes the selected session, repair this window locally
  // instead of leaving it pointed at an ID that can no longer hydrate.
  watch([
    activeSessionId,
    () => Object.values(sessionMetas.value),
    () => hasKnownSession(activeSessionId.value),
  ], ([sessionId, metas, isKnown]) => {
    const meta = metas.find(candidate => candidate.sessionId === sessionId)
    if (meta) {
      lastActiveSessionMeta = meta
      return
    }
    if (!sessionId || isKnown)
      return

    const characterId = lastActiveSessionMeta?.sessionId === sessionId
      ? lastActiveSessionMeta.characterId
      : getCurrentCharacterId()
    const fallbackSessionId = metas
      .find(candidate => candidate.characterId === characterId)
      ?.sessionId

    if (fallbackSessionId) {
      void setActiveSession(fallbackSessionId)
    }
    // If no fallback exists yet, wait for the synchronized delete action.
    // Its elected leader creates the single replacement; creating here in
    // every follower would fan one deletion out into several empty chats.
  })

  watch(activeCardId, async () => {
    if (!ready.value)
      return

    try {
      const sessionId = await useChatSessionStore().ensureCurrentSession()
      if (sessionId)
        activeSessionId.value = sessionId
    }
    catch (error) {
      console.error('[chat-session] Failed to select a session for the current character:', error)
    }
  })

  return {
    isReady,
    initialize,

    activeSessionId,
    messages,

    setActiveSession,
    applyRemoteSnapshot,
    getSnapshot,
    cleanupMessages,
    getAllSessions,
    resetAllSessions,

    ensureSession,
    deleteMessage,
    setSessionMessages,
    appendSessionMessage,
    commitUserMessage,
    recordInterruption,
    persistSessionMessages,
    getSessionMessages,
    getSessionMessagesIfLoaded,
    sessionMessages,
    sessionMetas,
    getSessionGeneration,
    bumpSessionGeneration,
    getSessionGenerationValue,
    // Pinia can synchronize only refs returned by a setup store.
    index,

    forkSession,
    exportSessions,
    importSessions,
    createSession,
    ensureBoundSession,
    setSessionTask,
    deleteHiddenSession,
    loadSession,
    refreshSession,
    deleteSession,
    ensureCurrentSession,
    ensureCharacterSession,
  }
}, {
  synced: {
    actions: [
      'commitUserMessage',
      'recordInterruption',
      'createSession',
      'deleteMessage',
      'deleteSession',
      'ensureCurrentSession',
      'ensureBoundSession',
      'ensureCharacterSession',
      'exportSessions',
      'forkSession',
      'importSessions',
      'loadSession',
      'refreshSession',
      'resetAllSessions',
      'setSessionTask',
      'deleteHiddenSession',
    ],
    state: true,
  },
})
