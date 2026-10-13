import type { VoiceInterruptionEvent } from '@proj-airi/core-agent'

import type { ChatHistoryItem } from './chat'

/** Storage and cross-window transport contain text diagnostics instead of live Error objects. */
export interface StoredVoiceInterruption extends Omit<VoiceInterruptionEvent, 'playback'> {
  playback: Omit<VoiceInterruptionEvent['playback'], 'error'> & { errorMessage?: string }
}

export interface ChatSessionMeta {
  sessionId: string
  userId: string
  characterId: string
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
