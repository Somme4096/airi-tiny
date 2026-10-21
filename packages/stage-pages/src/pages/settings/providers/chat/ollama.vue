<script setup lang="ts">
import type { RemovableRef } from '@vueuse/core'

import { errorMessageFromValue } from '@proj-airi/stage-shared'
import {
  ProviderAdvancedSettings,
  ProviderBaseUrlInput,
  ProviderBasicSettings,
  ProviderHeadersInput,
  ProviderSettingsContainer,
  ProviderSettingsLayout,
  ProviderValidationAlerts,
} from '@proj-airi/stage-ui/components'
import { useProviderValidation } from '@proj-airi/stage-ui/composables/use-provider-validation'
import { useProviderConfigStore } from '@proj-airi/stage-ui/stores/providers/config'
import { useProviderStore } from '@proj-airi/stage-ui/stores/providers/provider'
import { FieldCombobox } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed, onMounted, watch } from 'vue'

const providerId = 'ollama'
const providersStore = useProviderStore()
const providerStore = useProviderConfigStore()
const { configs: providers } = storeToRefs(providerStore) as { configs: RemovableRef<Record<string, any>> }

// Define computed properties for credentials
const baseUrl = computed({
  get: () => providers.value[providerId]?.baseUrl || 'http://localhost:11434/v1/',
  set: (value) => {
    if (!providers.value[providerId])
      providers.value[providerId] = {}
    providers.value[providerId].baseUrl = value
  },
})

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
  set: (value: string) => {
    if (!providers.value[providerId])
      providers.value[providerId] = {}
    providers.value[providerId].thinkingMode = value
  },
})

async function refetch() {
  try {
    const validationResult = await providersStore.validateProviderConfig(providerId, {
      baseUrl: baseUrl.value,
      thinkingMode: thinkingMode.value,
      headers: headers.value,
    })

    if (!validationResult.valid) {
      validationMessage.value = t('settings.dialogs.onboarding.validationError', {
        error: validationResult.reason,
      })
    }
  }
  catch (error) {
    validationMessage.value = t('settings.dialogs.onboarding.validationError', {
      error: errorMessageFromValue(error),
    })
  }
}

watch([baseUrl, thinkingMode, headers], refetch, { immediate: true, deep: true })
onMounted(async () => {
  await providersStore.initializeProvider(providerId)

  // Initialize refs with current values
  baseUrl.value = providers.value[providerId]?.baseUrl || providerMetadata.value?.defaultConfig.baseUrl || ''

  if (!providers.value[providerId].thinkingMode) {
    providers.value[providerId].thinkingMode = 'auto'
  }
})
</script>

<template>
  <ProviderSettingsLayout
    :provider-name="providerMetadata?.localizedName"
    :provider-icon-color="providerMetadata?.iconColor"
    :on-back="() => router.back()"
  >
    <ProviderSettingsContainer>
      <ProviderBasicSettings
        :title="t('settings.pages.providers.common.section.basic.title')"
        :description="t('settings.pages.providers.common.section.basic.description')"
        :on-reset="handleResetSettings"
      >
        <ProviderBaseUrlInput
          v-model="baseUrl"
          placeholder="http://localhost:11434/v1/"
        />
      </ProviderBasicSettings>

      <ProviderAdvancedSettings :title="t('settings.pages.providers.common.section.advanced.title')">
        <FieldCombobox
          v-model="thinkingMode"
          :label="t('settings.pages.providers.catalog.edit.config.common.fields.field.thinking-mode.label')"
          :description="t('settings.pages.providers.catalog.edit.config.common.fields.field.thinking-mode.description')"
          :options="[
            { label: t('settings.pages.providers.catalog.edit.config.common.fields.field.thinking-mode.options.auto'), value: 'auto' },
            { label: t('settings.pages.providers.catalog.edit.config.common.fields.field.thinking-mode.options.disable'), value: 'disable' },
            { label: t('settings.pages.providers.catalog.edit.config.common.fields.field.thinking-mode.options.enable'), value: 'enable' },
            { label: t('settings.pages.providers.catalog.edit.config.common.fields.field.thinking-mode.options.low'), value: 'low' },
            { label: t('settings.pages.providers.catalog.edit.config.common.fields.field.thinking-mode.options.medium'), value: 'medium' },
            { label: t('settings.pages.providers.catalog.edit.config.common.fields.field.thinking-mode.options.high'), value: 'high' },
          ]"
        />

        <ProviderHeadersInput v-model="headers" />
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
        :on-go-to-model-selection="() => router.push('/settings/modules/consciousness')"
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
