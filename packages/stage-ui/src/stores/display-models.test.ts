import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DisplayModelFormat, useDisplayModelsStore } from './display-models'

vi.mock('localforage', () => ({
  default: {
    getItem: vi.fn(async () => undefined),
    iterate: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
    setItem: vi.fn(async (_key: string, value: unknown) => value),
  },
}))

describe('display models store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('resolves newly imported display models from memory before IndexedDB', async () => {
    const store = useDisplayModelsStore()
    const model = {
      id: 'display-model-pending-idb-write',
      format: DisplayModelFormat.Live2dZip,
      type: 'file' as const,
      file: new File(['model'], 'model.zip'),
      name: 'model.zip',
      importedAt: 1,
    }

    store.displayModels = [model]

    const resolved = await store.getDisplayModel(model.id)

    expect(resolved).toEqual(model)
  })

  // The card store removes the references to a reported ID.
  it('reports a removed model as deleted', async () => {
    const store = useDisplayModelsStore()
    const deleted = vi.fn()
    store.onDisplayModelsDeleted(deleted)

    await store.removeDisplayModel('display-model-local')

    expect(deleted).toHaveBeenCalledWith(['display-model-local'])
  })
})
