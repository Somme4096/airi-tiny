// @vitest-environment jsdom

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { useConsciousnessSettingsStore } from './consciousness-settings'

describe('consciousness settings store', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('turns model reasoning off by default', () => {
    const store = useConsciousnessSettingsStore()

    expect(store.reasoning).toBe(false)
  })

  it('loads the persisted value', () => {
    localStorage.setItem('settings/consciousness/reasoning', 'true')
    const store = useConsciousnessSettingsStore()

    expect(store.reasoning).toBe(true)
  })

  it('persists changes through store actions', async () => {
    const store = useConsciousnessSettingsStore()
    await store.setReasoning(true)

    expect(store.reasoning).toBe(true)
    expect(localStorage.getItem('settings/consciousness/reasoning')).toBe('true')

    await store.resetState()

    expect(store.reasoning).toBe(false)
    expect(localStorage.getItem('settings/consciousness/reasoning')).toBe('false')
  })

  it('persists the context window and reads an empty or invalid value as not set', async () => {
    const store = useConsciousnessSettingsStore()

    await store.setContextWindow(8192.6)
    expect(store.contextWindow).toBe(8192)
    expect(localStorage.getItem('settings/consciousness/context-window')).toBe('8192')

    for (const value of ['', 0, -5, 'many']) {
      await store.setContextWindow(value)
      expect(store.contextWindow).toBeUndefined()
    }
    expect(localStorage.getItem('settings/consciousness/context-window')).toBe('')
  })

  it('applies the saved context window only while the custom length is on', async () => {
    const store = useConsciousnessSettingsStore()
    await store.setContextWindow(8192)

    expect(store.activeContextWindow).toBeUndefined()

    await store.setContextWindowEnabled(true)

    expect(store.activeContextWindow).toBe(8192)
    expect(localStorage.getItem('settings/consciousness/context-window-enabled')).toBe('true')
  })

  it('loads and resets the context window and the summary instructions', async () => {
    localStorage.setItem('settings/consciousness/context-window-enabled', 'true')
    localStorage.setItem('settings/consciousness/context-window', '16000')
    localStorage.setItem('settings/consciousness/summary-instructions', 'List only the promises.')
    const store = useConsciousnessSettingsStore()

    expect(store.contextWindow).toBe(16000)
    expect(store.activeContextWindow).toBe(16000)
    expect(store.summaryInstructions).toBe('List only the promises.')

    await store.resetState()

    expect(store.contextWindowEnabled).toBe(false)
    expect(store.contextWindow).toBeUndefined()
    expect(store.summaryInstructions).toBe('')
    expect(localStorage.getItem('settings/consciousness/summary-instructions')).toBe('')
  })

  it('ignores storage events because Pinia owns cross-window synchronization', () => {
    const store = useConsciousnessSettingsStore()

    window.dispatchEvent(new StorageEvent('storage', {
      key: 'settings/consciousness/reasoning',
      newValue: 'true',
    }))

    expect(store.reasoning).toBe(false)
  })
})
