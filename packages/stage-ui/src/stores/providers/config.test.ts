import type { InferenceServiceProvider } from '../../libs/providers/types'

import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from 'vue'

import { useProviderConfigStore } from './config'

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>()

  get length() {
    return this.values.size
  }

  clear() {
    this.values.clear()
  }

  getItem(key: string) {
    return this.values.get(key) ?? null
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null
  }

  removeItem(key: string) {
    this.values.delete(key)
  }

  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
}

vi.mock('../../libs/providers', () => ({
  getDefinedProvider: vi.fn(() => ({ id: 'openai-compatible', name: 'OpenAI Compatible' })),
}))

const localProvider = {
  id: 'local-provider',
  definitionId: 'openai-compatible',
  config: { apiKey: 'sk-local' },
  status: 'unconfigured',
} satisfies InferenceServiceProvider

function installStore() {
  const app = createApp({})
  const pinia = createPinia()
  app.use(pinia)
  setActivePinia(pinia)
  return useProviderConfigStore()
}

describe('provider config store', () => {
  beforeEach(() => {
    const storage = new MemoryStorage()
    vi.stubGlobal('localStorage', storage)
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
      localStorage: storage,
      removeEventListener: vi.fn(),
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('adds a local provider instance', async () => {
    const store = installStore()

    const added = await store.addProvider('openai-compatible', { apiKey: 'sk-new' })

    expect(added.definitionId).toBe('openai-compatible')
    expect(store.listedProviders[added.id]?.config).toEqual({ apiKey: 'sk-new' })
  })

  it('removes a provider and its listed marker', async () => {
    const store = installStore()
    const added = await store.addProvider('openai-compatible', { apiKey: 'sk-new' })

    await store.removeProvider(added.id)

    expect(store.getProvider(added.id)).toBeUndefined()
    expect(store.addedProviders[added.id]).toBeUndefined()
  })

  it('patches configuration through the owning provider record', async () => {
    const store = installStore()
    store.providers[localProvider.id] = {
      ...localProvider,
      config: { baseUrl: 'https://example.com/v1/' },
    }

    expect(await store.patchProviderConfig(localProvider.id, { apiKey: 'sk-test' })).toBe(true)
    expect(store.getProviderConfig(localProvider.id)).toEqual({
      apiKey: 'sk-test',
      baseUrl: 'https://example.com/v1/',
    })
  })

  it('does not create an incomplete provider while patching configuration', async () => {
    const store = installStore()

    expect(await store.patchProviderConfig('missing-provider', { apiKey: 'sk-test' })).toBe(false)
    expect(store.getProvider('missing-provider')).toBeUndefined()
  })
})
