<script setup lang="ts">
import type { RemovableRef } from '@vueuse/core'

import {
  ProviderAdvancedSettings,
  ProviderApiKeyInput,
  ProviderBaseUrlInput,
  ProviderBasicSettings,
  ProviderGenerationSettings,
  ProviderHeadersInput,
  ProviderSettingsContainer,
  ProviderSettingsLayout,
  ProviderValidationAlerts,
} from '@proj-airi/stage-ui/components'
import { useProviderValidation } from '@proj-airi/stage-ui/composables/use-provider-validation'
import { getDefinedProvider } from '@proj-airi/stage-ui/libs'
import { useConsciousnessStore } from '@proj-airi/stage-ui/stores/modules/consciousness'
import { useProviderConfigStore } from '@proj-airi/stage-ui/stores/providers/config'
import { useProviderStore } from '@proj-airi/stage-ui/stores/providers/provider'
import { FieldCombobox } from '@proj-airi/ui'
import { computedAsync } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { z } from 'zod'

const route = useRoute('/settings/providers/chat/[providerId]')
const routeProviderId = route.params.providerId
if (typeof routeProviderId !== 'string')
  throw new Error('Expected a provider id in the settings route')
const providerId = routeProviderId
const providerConfigStore = useProviderConfigStore()
const providersStore = useProviderStore()
const consciousnessStore = useConsciousnessStore()
const { configs: providers } = storeToRefs(providerConfigStore) as { configs: RemovableRef<Record<string, any>> }
const { activeProvider } = storeToRefs(consciousnessStore)
const providerDefinition = computed(() => providersStore.findProviderDefinition(providerId))

// Define computed properties for credentials
const apiKey = computed({
  get: () => providers.value[providerId]?.apiKey || '',
  set: (value) => {
    if (!providers.value[providerId])
      providers.value[providerId] = {}
    providers.value[providerId].apiKey = value
  },
})

const baseUrl = computed({
  get: () => providers.value[providerId]?.baseUrl || '',
  set: (value) => {
    if (!providers.value[providerId])
      providers.value[providerId] = {}
    providers.value[providerId].baseUrl = value
  },
})

const headers = computed<Record<string, string> | undefined>({
  get: () => providers.value[providerId]?.headers,
  set: (value) => {
    if (!providers.value[providerId])
      providers.value[providerId] = {}
    providers.value[providerId].headers = value
  },
})

const thinkingMode = computed({
  get: () => providers.value[providerId]?.thinkingMode || 'auto',
  set: (value) => {
    if (!providers.value[providerId])
      providers.value[providerId] = {}
    providers.value[providerId].thinkingMode = value
  },
})

const supportsDeepSeekThinkingMode = computed(() => providerDefinition.value?.id === 'deepseek')

// Use the composable to get validation logic and state
const {
  t,
  router,
  providerMetadata,
  isValidating,
  isValid,
  validationMessage,
  handleResetSettings,
  forceValid,
  hasManualValidators,
  isManualTesting,
  manualTestPassed,
  manualTestMessage,
  runManualTest,
} = useProviderValidation(providerId)

// The page renders its fields by hand. The schema metadata selects the API key
// placeholder and shows the headers input for providers that send custom headers.
const providerSchemaShape = computedAsync(async () => {
  const definition = providerDefinition.value ?? getDefinedProvider(providerId)
  const schema = await definition?.createProviderConfig({ t })
  return schema instanceof z.ZodObject ? schema.shape : undefined
})

const apiKeyPlaceholder = computed(() => {
  const meta = providerSchemaShape.value?.apiKey?.meta()
  return typeof meta?.placeholderLocalized === 'string' ? meta.placeholderLocalized : 'sk-...'
})

const supportsCustomHeaders = computed(() => providerSchemaShape.value?.headers?.meta()?.type === 'key-values')

function goToModelSelection() {
  activeProvider.value = providerId
  router.push('/settings/modules/consciousness')
}
</script>

<template>
  <ProviderSettingsLayout
    :provider-name="providerMetadata?.localizedName"
    :provider-icon="providerMetadata?.icon"
    :provider-icon-color="providerMetadata?.iconColor"
    :on-back="() => router.back()"
  >
    <ProviderSettingsContainer>
      <ProviderBasicSettings
        :title="t('settings.pages.providers.common.section.basic.title')"
        :description="t('settings.pages.providers.common.section.basic.description')"
        :on-reset="handleResetSettings"
      >
        <ProviderApiKeyInput
          v-model="apiKey"
          :provider-name="providerMetadata?.localizedName"
          :placeholder="apiKeyPlaceholder"
        />
        <ProviderGenerationSettings :provider-id="providerId" />
      </ProviderBasicSettings>

      <ProviderAdvancedSettings :title="t('settings.pages.providers.common.section.advanced.title')">
        <ProviderBaseUrlInput
          v-model="baseUrl"
          :placeholder="providerMetadata?.defaultConfig.baseUrl as string || 'Base URL of your provider'"
        />

        <FieldCombobox
          v-if="supportsDeepSeekThinkingMode"
          v-model="thinkingMode"
          :label="t('settings.pages.providers.catalog.edit.config.common.fields.field.thinking-mode.label')"
          :description="t('settings.pages.providers.provider.deepseek.fields.field.thinking-mode.description')"
          :options="[
            { label: t('settings.pages.providers.catalog.edit.config.common.fields.field.thinking-mode.options.auto'), value: 'auto' },
            { label: t('settings.pages.providers.catalog.edit.config.common.fields.field.thinking-mode.options.disable'), value: 'disable' },
            { label: t('settings.pages.providers.catalog.edit.config.common.fields.field.thinking-mode.options.enable'), value: 'enable' },
          ]"
        />

        <ProviderHeadersInput v-if="supportsCustomHeaders" v-model="headers" />
      </ProviderAdvancedSettings>

      <ProviderValidationAlerts
        :is-valid="isValid"
        :is-validating="isValidating"
        :validation-message="validationMessage"
        :has-manual-validators="hasManualValidators"
        :is-manual-testing="isManualTesting"
        :manual-test-passed="manualTestPassed"
        :manual-test-message="manualTestMessage"
        :on-run-test="runManualTest"
        :on-force-valid="forceValid"
        :on-go-to-model-selection="goToModelSelection"
      />
    </ProviderSettingsContainer>
  </ProviderSettingsLayout>
</template>

<route lang="yaml">
meta:
  layout: settings
  stageTransition:
    name: slide
</route>
