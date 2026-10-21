import en from '@proj-airi/i18n/locales/en'

import { useProviderConfigStore } from '@proj-airi/stage-ui/stores/providers/config'
import { createPinia, disposePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-vue'
import { page } from 'vitest/browser'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'

import ChatProviderPage from './[providerId].vue'

import 'virtual:uno.css'

describe('chat provider settings custom headers', () => {
  let pinia: ReturnType<typeof createPinia>

  beforeEach(() => {
    localStorage.clear()
    pinia = createPinia()
    // Validation starts on mount. The page must show the form without a reachable server.
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => {
      throw new TypeError('Provider server unavailable')
    }))
  })

  afterEach(() => {
    disposePinia(pinia)
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  async function renderProviderPage(providerId: string) {
    await page.viewport(1100, 1400)
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/settings/providers/chat/:providerId', component: { template: '<div />' } },
        { path: '/settings/modules/consciousness', component: { template: '<div />' } },
      ],
    })
    await router.push(`/settings/providers/chat/${providerId}`)
    const screen = await render(ChatProviderPage, {
      global: {
        plugins: [pinia, router, createI18n({ legacy: false, locale: 'en', messages: { en } })],
        directives: { autoAnimate: {}, motion: {} },
      },
    })
    await screen.getByText('Advanced', { exact: true }).click()
    return screen
  }

  it('shows the saved custom headers of an OpenAI-compatible provider', async () => {
    useProviderConfigStore(pinia).ensureProvider('opencode-go', 'opencode-go', { apiKey: 'test-key', headers: { 'X-Custom': 'yes' } })
    const screen = await renderProviderPage('opencode-go')

    await expect.element(screen.getByPlaceholder('Key').first()).toHaveValue('X-Custom')
    await expect.element(screen.getByPlaceholder('Value').first()).toHaveValue('yes')
  })

  // ROOT CAUSE:
  //
  // The provider page rendered only the API key, base URL, and DeepSeek thinking mode.
  // Providers accepted custom headers, but no reachable page let the user enter them.
  it('saves a header that the user enters, including the value typed before the key', async () => {
    const store = useProviderConfigStore(pinia)
    store.ensureProvider('openai-compatible', 'openai-compatible', { apiKey: 'test-key', baseUrl: 'https://custom.test/v1' })
    const screen = await renderProviderPage('openai-compatible')

    // A row without a key is not saved. The editor must keep it while the user types.
    await screen.getByPlaceholder('Value').first().fill('team-a')
    await screen.getByPlaceholder('Key').first().fill('X-Gateway')

    await expect.poll(() => store.getProviderConfig('openai-compatible')?.headers).toEqual({ 'X-Gateway': 'team-a' })
    // The editor adds an empty row for the next header.
    await expect.poll(async () => (await screen.getByPlaceholder('Key').all()).length).toBe(2)
  })

  it('hides the headers input for a provider that does not send custom headers', async () => {
    useProviderConfigStore(pinia).ensureProvider('azure-openai', 'azure-openai', { apiKey: 'test-key' })
    const screen = await renderProviderPage('azure-openai')

    await expect.element(screen.getByText('Base URL', { exact: true })).toBeVisible()
    expect(await screen.getByPlaceholder('Key').all()).toHaveLength(0)
  })
})
