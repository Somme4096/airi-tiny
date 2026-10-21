import { createXai } from '@xsai-ext/providers/create'
import { z } from 'zod'

import { customHeadersField, customHeadersSchema, withCustomHeaders } from '../../../headers'
import { ProviderValidationCheck } from '../../../types'
import { createOpenAICompatibleValidators } from '../../../validators'
import { defineProvider } from '../../registry'

const xaiConfigSchema = z.object({
  apiKey: z
    .string('API Key'),
  baseUrl: z
    .string('Base URL')
    .optional()
    .default('https://api.x.ai/v1/'),
  headers: customHeadersSchema,
})

type XAIConfig = z.input<typeof xaiConfigSchema>

export const providerXAI = defineProvider<XAIConfig, 'xai'>({
  id: 'xai',
  name: 'xAI',
  nameLocalize: ({ t }) => t('settings.pages.providers.provider.xai.title'),
  description: 'x.ai',
  descriptionLocalize: ({ t }) => t('settings.pages.providers.provider.xai.description'),
  tasks: ['chat'],
  icon: 'i-lobe-icons:xai',

  createProviderConfig: ({ t }) => xaiConfigSchema.extend({
    apiKey: xaiConfigSchema.shape.apiKey.meta({
      labelLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.label'),
      descriptionLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.description'),
      placeholderLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.placeholder'),
      type: 'password',
    }),
    baseUrl: xaiConfigSchema.shape.baseUrl.meta({
      labelLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.base-url.label'),
      descriptionLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.base-url.description'),
      placeholderLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.base-url.placeholder'),
    }),
    headers: customHeadersField({ t }),
  }),
  createProvider(config) {
    return withCustomHeaders(createXai(config.apiKey, config.baseUrl), config.headers)
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
