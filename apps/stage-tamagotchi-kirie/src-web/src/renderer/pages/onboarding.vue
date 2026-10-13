<script setup lang="ts">
import { useHostOnboarding } from '@proj-airi/stage-host-context'
import { OnboardingScreen, OnboardingStepAnalyticsNotice } from '@proj-airi/stage-ui/components'
import { isAnalyticsAvailableInBuild } from '@proj-airi/stage-ui/libs/product-signals'
import { useOnboardingStore } from '@proj-airi/stage-ui/stores/onboarding'
import { useTheme } from '@proj-airi/ui'
import { computed } from 'vue'

const onboardingStore = useOnboardingStore()
const { isDark } = useTheme()
const { close: closeWindow } = useHostOnboarding()
let closing = false

/** Closes the onboarding window one time. A failed close permits a retry. */
async function closeOnboardingWindow(): Promise<void> {
  if (closing)
    return

  closing = true
  try {
    await closeWindow()
  }
  catch (error) {
    closing = false
    console.error('[Onboarding] Failed to close the onboarding window.', error)
  }
}

const bgClass = computed(() => isDark.value ? 'bg-[#0f0f0f]' : 'bg-white')
const extraSteps = computed(() => {
  return isAnalyticsAvailableInBuild()
    ? [{ id: 'analytics-notice', component: OnboardingStepAnalyticsNotice }]
    : []
})

async function handleSkipped() {
  onboardingStore.markSetupSkipped()
  await closeOnboardingWindow()
}

async function handleConfigured() {
  onboardingStore.markSetupCompleted()
  await closeOnboardingWindow()
}
</script>

<template>
  <!-- Same flex/min-h-0 chain as OnboardingDialog so model step grid scrolls inside the viewport (not the whole page). -->
  <div
    class="onboarding-root h-full min-h-0 w-full flex flex-col overflow-hidden overscroll-none"
    :class="bgClass"
  >
    <div class="min-h-8 w-full flex-shrink-0 select-none" :class="bgClass" />
    <div class="mx-8 mb-8 mt-2 min-h-0 flex flex-1 flex-col">
      <OnboardingScreen :extra-steps="extraSteps" @skipped="handleSkipped" @configured="handleConfigured" />
    </div>
  </div>
</template>

<style scoped>
.onboarding-root {
  scrollbar-width: none;
}

.onboarding-root::-webkit-scrollbar {
  display: none;
}
</style>

<route lang="yaml">
meta:
  layout: plain
</route>
