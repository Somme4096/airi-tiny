import type { GenerationRequest } from '../../../types'

import { createOpencodeGo } from '@xsai-ext/providers/create'
import { z } from 'zod'

import { compatibleProtocols, generationProtocolOptions } from '../../../generation'
import { customHeadersField, customHeadersSchema, mergeRequestHeaders, withCustomHeaders } from '../../../headers'
import { ProviderValidationCheck } from '../../../types'
import { createOpenAICompatibleValidators } from '../../../validators'
import { defineProvider } from '../../registry'

// NOTICE:
// This path serves the model list, Chat Completions, and Responses.
// The documented `/inference/go/openai/v1/` path has no model list, and the xsAI default `/zen/go/v1` is the old path.
// Source: https://opencode.ai/v2/docs/console/go/, checked with HTTP requests on 2026-10-21.
// Removal condition: Go documents one base URL for all three endpoints.
const defaultBaseUrl = 'https://opencode.ai/inference/go/v1/'

const configSchema = z.object({
  api: z.enum(compatibleProtocols.supportedProtocols).default(compatibleProtocols.defaultProtocol),
  apiKey: z
    .string('API Key'),
  baseUrl: z
    .string('Base URL')
    .optional()
    .default(defaultBaseUrl),
  headers: customHeadersSchema,
})

type Config = z.input<typeof configSchema>

export const providerOpencodeGo = defineProvider<Config, 'opencode-go'>({
  id: 'opencode-go',
  name: 'OpenCode Go',
  nameLocalize: ({ t }) => t('settings.pages.providers.provider.opencode-go.title'),
  description: 'opencode.ai',
  descriptionLocalize: ({ t }) => t('settings.pages.providers.provider.opencode-go.description'),
  tasks: ['chat'],
  capabilities: { chat: { generation: compatibleProtocols } },
  icon: 'i-lobe-icons:opencode',

  createProviderConfig: ({ t }) => configSchema.extend({
    api: configSchema.shape.api.meta({
      type: 'select',
      options: generationProtocolOptions(compatibleProtocols),
      labelLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-protocol.label'),
      descriptionLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-protocol.description'),
    }),
    apiKey: configSchema.shape.apiKey.meta({
      labelLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.label'),
      descriptionLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.description'),
      placeholderLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.placeholder'),
      type: 'password',
    }),
    baseUrl: configSchema.shape.baseUrl.meta({
      labelLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.base-url.label'),
      descriptionLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.base-url.description'),
      placeholderLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.base-url.placeholder'),
    }),
    headers: customHeadersField({ t }),
  }),
  createProvider(config) {
    const provider = createOpencodeGo(config.apiKey, config.baseUrl ?? defaultBaseUrl)
    // Go rejects a generation request without `x-opencode-session` (HTTP 400 `MissingSessionID`).
    // Go uses the ID to route requests and to reuse prompt caches.
    // The ID is stable for the life of this instance, so the conversations of one app run share it.
    // A custom header with the same name replaces it.
    const headers = mergeRequestHeaders({ 'x-opencode-session': crypto.randomUUID() }, config.headers)
    return withCustomHeaders({
      model: provider.model,
      generation(model: string): GenerationRequest {
        const request = provider.chat(model)
        switch (config.api ?? compatibleProtocols.defaultProtocol) {
          case 'responses':
            return { protocol: 'responses', config: request, webSearch: false }
          case 'chat-completions':
            return { protocol: 'chat-completions', config: request }
        }
      },
    }, headers)
  },

  validationRequiredWhen(config) {
    return !!config.apiKey?.trim()
  },
  validators: {
    ...createOpenAICompatibleValidators({
      checks: [ProviderValidationCheck.Connectivity, ProviderValidationCheck.ModelList, ProviderValidationCheck.ChatCompletions],
    }),
  },
})
