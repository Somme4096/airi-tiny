import type { DisplayModelFile } from '../../stores/display-models'

import localforage from 'localforage'

/** The part of localforage that the repository uses. */
export interface DisplayModelStore {
  getItem: <T>(key: string) => Promise<T | null>
  setItem: <T>(key: string, value: T) => Promise<T>
  removeItem: (key: string) => Promise<void>
  iterate: <T, U>(callback: (value: T, key: string) => U) => Promise<U>
}

type StoredDisplayModel = Omit<DisplayModelFile, 'id' | 'type' | 'name'> & { name?: string }

const modelPrefix = 'display-model-'

/**
 * Device storage for imported display models.
 * Models keep the localforage keys that earlier releases wrote, so existing imports stay in place.
 */
export function createDisplayModelsRepo(store: DisplayModelStore) {
  return {
    async list() {
      const models: DisplayModelFile[] = []
      await store.iterate<StoredDisplayModel, void>((value, key) => {
        if (key.startsWith(modelPrefix))
          models.push({ ...value, id: key, type: 'file', name: value.name ?? value.file.name })
      })
      return models
    },

    async get(id: string) {
      return await store.getItem<DisplayModelFile>(id) ?? undefined
    },

    async save(model: DisplayModelFile) {
      await store.setItem(model.id, model)
    },

    async remove(id: string) {
      await store.removeItem(id)
    },
  }
}

export const displayModelsRepo = createDisplayModelsRepo(localforage)
