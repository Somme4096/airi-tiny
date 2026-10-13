import type {} from 'pinia-plugin-synced'

import { defineStore } from 'pinia'
import { computed, shallowRef } from 'vue'

function loadEnabled(key: string) {
  // Non-renderer runtimes have no durable settings owner. They use the product
  // default until a synchronized renderer snapshot arrives.
  if (typeof localStorage === 'undefined')
    return false

  return localStorage.getItem(`settings/consciousness/${key}`) === 'true'
}

function persistEnabled(key: string, value: boolean) {
  if (typeof localStorage === 'undefined')
    return

  localStorage.setItem(`settings/consciousness/${key}`, String(value))
}

function loadText(key: string) {
  if (typeof localStorage === 'undefined')
    return ''

  return localStorage.getItem(`settings/consciousness/${key}`) ?? ''
}

function persistText(key: string, value: string) {
  if (typeof localStorage === 'undefined')
    return

  localStorage.setItem(`settings/consciousness/${key}`, value)
}

/** Reads a token count from a form field or from storage. An empty, zero, or invalid value means "not set". */
function toTokenCount(value: unknown) {
  const count = Math.floor(Number(value))
  return Number.isFinite(count) && count > 0 ? count : undefined
}

/**
 * Stores request policies for the consciousness module.
 *
 * Consciousness chat request preparation reads this state before inference.
 * Each provider maps the reasoning value to its own request fields.
 */
export const useConsciousnessSettingsStore = defineStore('consciousness-settings', () => {
  // Pinia owns live cross-window state. Only synchronized actions write the
  // durable value, so a follower cannot persist an uncommitted proposal.
  const reasoning = shallowRef(loadEnabled('reasoning'))
  const temperatureEnabled = shallowRef(loadEnabled('temperature-enabled'))
  const topPEnabled = shallowRef(loadEnabled('top-p-enabled'))
  const contextWindowEnabled = shallowRef(loadEnabled('context-window-enabled'))
  /** Saved context window. It applies only while `contextWindowEnabled` is on. */
  const contextWindow = shallowRef(toTokenCount(loadText('context-window')))
  /** Context window that replaces the one the model reports. `undefined` uses the reported one. */
  const activeContextWindow = computed(() => contextWindowEnabled.value ? contextWindow.value : undefined)
  /** Instructions of the history summary request. An empty text uses the built-in instructions. */
  const summaryInstructions = shallowRef(loadText('summary-instructions'))

  async function setReasoning(value: boolean) {
    reasoning.value = value
    persistEnabled('reasoning', value)
  }

  async function setTemperatureEnabled(value: boolean) {
    temperatureEnabled.value = value
    persistEnabled('temperature-enabled', value)
  }

  async function setTopPEnabled(value: boolean) {
    topPEnabled.value = value
    persistEnabled('top-p-enabled', value)
  }

  async function setContextWindowEnabled(value: boolean) {
    contextWindowEnabled.value = value
    persistEnabled('context-window-enabled', value)
  }

  async function setContextWindow(value: unknown) {
    contextWindow.value = toTokenCount(value)
    persistText('context-window', contextWindow.value === undefined ? '' : String(contextWindow.value))
  }

  async function setSummaryInstructions(value: string) {
    summaryInstructions.value = value
    persistText('summary-instructions', value)
  }

  async function resetState() {
    await setReasoning(false)
    await setTemperatureEnabled(false)
    await setTopPEnabled(false)
    await setContextWindowEnabled(false)
    await setContextWindow(undefined)
    await setSummaryInstructions('')
  }

  return {
    reasoning,
    temperatureEnabled,
    topPEnabled,
    contextWindowEnabled,
    contextWindow,
    activeContextWindow,
    summaryInstructions,
    setReasoning,
    setTemperatureEnabled,
    setTopPEnabled,
    setContextWindowEnabled,
    setContextWindow,
    setSummaryInstructions,
    resetState,
  }
}, {
  synced: {
    actions: ['resetState', 'setContextWindow', 'setContextWindowEnabled', 'setReasoning', 'setSummaryInstructions', 'setTemperatureEnabled', 'setTopPEnabled'],
    state: true,
  },
})
