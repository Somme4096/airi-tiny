import type { ChatSessionRecord, ChatSessionsIndex } from '../../types/chat-session'

import { chatAssetIdsOf, extractInlineChatAssets } from '../../libs/chat-assets'
import { storage } from '../storage'
import { chatAssetsRepo } from './chat-assets.repo'

/** Asset IDs that each session already owns in this window. A save adds the session as owner only for new IDs. */
const ownedAssets = new Map<string, Set<string>>()

async function retainAssets(sessionId: string, record: ChatSessionRecord) {
  const owned = ownedAssets.get(sessionId) ?? new Set<string>()
  const added = [...chatAssetIdsOf(record.messages)].filter(id => !owned.has(id))
  if (!added.length)
    return
  await chatAssetsRepo.retain(added, sessionId)
  added.forEach(id => owned.add(id))
  ownedAssets.set(sessionId, owned)
}

export const chatSessionsRepo = {
  async getIndex(userId: string) {
    const key = `local:chat/index/${userId}`
    return await storage.getItemRaw<ChatSessionsIndex>(key)
  },

  async saveIndex(index: ChatSessionsIndex) {
    const key = `local:chat/index/${index.userId}`
    await storage.setItemRaw(key, index)
  },

  /** A record that still holds image or audio bytes moves them into the asset store and is saved with references. */
  async getSession(sessionId: string) {
    const key = `local:chat/sessions/${sessionId}`
    const record = await storage.getItemRaw<ChatSessionRecord>(key)
    if (!record)
      return record
    const messages = await extractInlineChatAssets(record.messages, sessionId)
    if (messages === record.messages)
      return record
    const migrated = { ...record, messages }
    await this.saveSession(sessionId, migrated)
    return migrated
  },

  /**
   * The session becomes an owner of every asset that its messages reference.
   * A copied message, for example in a fork or an import, then keeps its asset after the source session is deleted.
   */
  async saveSession(sessionId: string, record: ChatSessionRecord) {
    const key = `local:chat/sessions/${sessionId}`
    await retainAssets(sessionId, record)
    await storage.setItemRaw(key, record)
  },

  /**
   * The session stops owning the listed assets, for example after one of its messages is deleted.
   * An asset that no other session owns is deleted.
   */
  async releaseAssets(sessionId: string, ids: Iterable<string>) {
    const released = [...ids]
    if (!released.length)
      return
    await chatAssetsRepo.release(released, sessionId)
    released.forEach(id => ownedAssets.get(sessionId)?.delete(id))
  },

  // Cleanup
  /** Assets that no other session owns are deleted with the session. */
  async deleteSession(sessionId: string) {
    await storage.removeItem(`local:chat/sessions/${sessionId}`)
    ownedAssets.delete(sessionId)
    await chatAssetsRepo.releaseOwner(sessionId)
  },

  async clear(userId: string) {
    const index = await this.getIndex(userId)
    if (index) {
      for (const charIndex of Object.values(index.characters)) {
        for (const sessionId of Object.keys(charIndex.sessions)) {
          await this.deleteSession(sessionId)
        }
      }
      await storage.removeItem(`local:chat/index/${userId}`)
    }
  },
}
