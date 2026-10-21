import type { ChatRequestOptions } from '../../../types'

import { createNovita } from '@xsai-ext/providers/create'
import { z } from 'zod'

import { customHeadersField, customHeadersSchema, withCustomHeaders } from '../../../headers'
import { ProviderValidationCheck } from '../../../types'
import { createOpenAICompatibleValidators } from '../../../validators'
import { defineProvider } from '../../registry'

const novitaConfigSchema = z.object({
  apiKey: z
    .string('API Key'),
  baseUrl: z
    .string('Base URL')
    .optional()
    .default('https://api.novita.ai/openai/'),
  headers: customHeadersSchema,
})

type NovitaConfig = z.input<typeof novitaConfigSchema>

export const providerNovitaAI = defineProvider<NovitaConfig, 'novita-ai'>({
  id: 'novita-ai',
  name: 'Novita',
  nameLocalize: ({ t }) => t('settings.pages.providers.provider.novita.title'),
  description: 'novita.ai',
  descriptionLocalize: ({ t }) => t('settings.pages.providers.provider.novita.description'),
  tasks: ['chat'],
  capabilities: { chat: { reasoning: { modes: ['enabled', 'disabled'] } } },
  icon: 'i-lobe-icons:novita',
  iconColor: 'i-lobe-icons:novita-color',

  createProviderConfig: ({ t }) => novitaConfigSchema.extend({
    apiKey: novitaConfigSchema.shape.apiKey.meta({
      labelLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.label'),
      descriptionLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.description'),
      placeholderLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.placeholder'),
      type: 'password',
    }),
    baseUrl: novitaConfigSchema.shape.baseUrl.meta({
      labelLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.base-url.label'),
      descriptionLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.base-url.description'),
      placeholderLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.base-url.placeholder'),
    }),
    headers: customHeadersField({ t }),
  }),
  createProvider(config) {
    const provider = createNovita(config.apiKey, config.baseUrl)
    return withCustomHeaders({
      ...provider,
      chat(model: string, options?: ChatRequestOptions) {
        const request = provider.chat(model)
        if (!options?.reasoning)
          return request

        return { ...request, enableThinking: options.reasoning === 'enabled' }
      },
    }, config.headers)
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
