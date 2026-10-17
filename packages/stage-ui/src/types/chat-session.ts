import type { VoiceInterruptionEvent } from '@proj-airi/core-agent'

import type { ChatHistoryItem } from './chat'

/** Storage and cross-window transport contain text diagnostics instead of live Error objects. */
export interface StoredVoiceInterruption extends Omit<VoiceInterruptionEvent, 'playback'> {
  playback: Omit<VoiceInterruptionEvent['playback'], 'error'> & { errorMessage?: string }
}

/**
 * Where a background task stands. `interrupted` means the owner stopped it or the app closed while it ran.
 */
export type ChatSessionTaskStatus = 'running' | 'done' | 'failed' | 'interrupted'

export interface ChatSessionTask {
  status: ChatSessionTaskStatus
  /** When the task started. */
  startedAt: number
  endedAt?: number
}

export interface ChatSessionMeta {
  sessionId: string
  userId: string
  characterId: string
  /** External scene identities that recover this session within its user and persona partition. */
  bindings?: string[]
  /** Session from which this conversation branch was copied. */
  parentSessionId?: string
  /** Excludes task branches from conversation navigation. */
  hidden?: boolean
  /** The recipe whose own space this session is. Its runs read the recipe's steps, and only the host starts them. */
  recipeId?: string
  /** The background task that this session runs. Each task has its own session, so the status stays after the task ends. */
  task?: ChatSessionTask
  title?: string
  createdAt: number
  updatedAt: number
  /** Control events inform later agent requests without adding user messages. */
  controlEvents?: StoredVoiceInterruption[]
}

export interface ChatSessionRecord {
  meta: ChatSessionMeta
  messages: ChatHistoryItem[]
}

export interface ChatCharacterSessionsIndex {
  activeSessionId: string
  sessions: Record<string, ChatSessionMeta>
}

export interface ChatSessionsIndex {
  userId: string
  characters: Record<string, ChatCharacterSessionsIndex>
}

export interface ChatSessionsExport {
  format: 'chat-sessions-index:v1'
  index: ChatSessionsIndex
  sessions: Record<string, ChatSessionRecord>
}
