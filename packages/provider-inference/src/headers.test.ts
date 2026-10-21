import { describe, expect, it } from 'vitest'

import { conversationHeaders, mergeRequestHeaders } from './headers'

describe('conversation headers', () => {
  it('binds each OpenCode Go request to its chat conversation', () => {
    expect(conversationHeaders('opencode-go', 'session-a')).toEqual({ 'x-opencode-session': 'session-a' })
    expect(conversationHeaders('opencode-go', 'session-b')).toEqual({ 'x-opencode-session': 'session-b' })
  })

  it('adds no conversation header for other providers', () => {
    expect(conversationHeaders('openai', 'session-a')).toEqual({})
  })

  it('replaces a configured session header without regard to casing', () => {
    expect(mergeRequestHeaders({ 'X-Opencode-Session': 'pinned' }, conversationHeaders('opencode-go', 'session-a')))
      .toEqual({ 'x-opencode-session': 'session-a' })
  })
})
