import type { ChatRequestOptions, GenerationRequest, ProviderContext, ProviderInstance } from './types'

import { z } from 'zod'

import { isGenerationProvider } from './types'

/**
 * HTTP headers that the user adds to each request of an OpenAI-compatible provider.
 * Provider settings edit them as key and value rows in the advanced section.
 */
export const customHeadersSchema = z.record(z.string(), z.string()).optional()

/** Custom headers stored in a provider configuration. */
export type CustomHeaders = z.output<typeof customHeadersSchema>

/** Instance methods that return the options of one xsAI request. */
const requestMethodNames = ['chat', 'embed', 'model', 'speech', 'transcription'] as const

/** Adds the settings editor metadata to {@link customHeadersSchema}. */
export function customHeadersField({ t }: ProviderContext) {
  return customHeadersSchema.meta({
    labelLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.headers.label'),
    descriptionLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.headers.description'),
    section: 'advanced',
    type: 'key-values',
  })
}

/**
 * Merges request headers. Override names replace configured names without regard to casing.
 * Authorization keeps the SDK spelling, so it also replaces the header that xsAI builds from `apiKey`.
 *
 * @example
 * mergeRequestHeaders({ 'X-Trace': 'a' }, { 'x-trace': 'b', 'authorization': 'Bearer c' })
 * // => { 'x-trace': 'b', 'Authorization': 'Bearer c' }
 */
export function mergeRequestHeaders(configured: HeadersInit | undefined, overrides: HeadersInit | undefined): Record<string, string> {
  const headers = new Headers(configured)
  new Headers(overrides).forEach((value, name) => headers.set(name, value))
  return Object.fromEntries(Array.from(headers, ([name, value]) => [name === 'authorization' ? 'Authorization' : name, value]))
}

/**
 * Builds the headers that bind one provider request to a chat conversation.
 * OpenCode Go routes and caches per conversation only when this header stays stable.
 */
export function conversationHeaders(providerId: string, conversationId: string): Record<string, string> {
  if (providerId === 'opencode-go')
    return { 'x-opencode-session': conversationId }
  return {}
}

function withHeaders<TOptions extends { headers?: HeadersInit }>(options: TOptions, headers: Record<string, string>): TOptions {
  return { ...options, headers: mergeRequestHeaders(options.headers, headers) }
}

/**
 * Adds custom headers to every request that the instance builds: chat, generation, model listing, and other xsAI requests.
 * Custom headers replace provider headers of the same name. Without headers, the instance is returned unchanged.
 */
export function withCustomHeaders<TProvider extends ProviderInstance>(provider: TProvider, headers: CustomHeaders): TProvider {
  if (!headers || Object.keys(headers).length === 0)
    return provider

  const wrapped: TProvider = { ...provider }
  for (const name of requestMethodNames) {
    const method: unknown = Reflect.get(provider, name)
    if (typeof method === 'function')
      Reflect.set(wrapped, name, (...args: unknown[]) => withHeaders(Reflect.apply(method, provider, args), headers))
  }

  if (isGenerationProvider(provider)) {
    Reflect.set(wrapped, 'generation', (model: string, options?: ChatRequestOptions): GenerationRequest => {
      const request = provider.generation(model, options)
      switch (request.protocol) {
        case 'chat-completions':
          return { ...request, config: withHeaders(request.config, headers) }
        case 'responses':
          return { ...request, config: withHeaders(request.config, headers) }
      }
    })
  }

  return wrapped
}
