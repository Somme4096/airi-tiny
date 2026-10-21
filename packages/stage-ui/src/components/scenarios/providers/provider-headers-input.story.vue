<script setup lang="ts">
import { ref } from 'vue'

import ProviderHeadersInput from './provider-headers-input.vue'

const emptyHeaders = ref<Record<string, string>>()
const savedHeaders = ref<Record<string, string>>({ 'X-Gateway-Team': 'airi', 'x-opencode-session': 'my-session' })
</script>

<template>
  <Story
    title="Headers Input"
    group="providers"
    :layout="{ type: 'grid', width: '100%' }"
  >
    <template #controls>
      <ThemeColorsHueControl />
    </template>

    <Variant
      id="empty"
      title="Empty"
    >
      <div>
        <ProviderHeadersInput v-model="emptyHeaders" />
      </div>
    </Variant>

    <Variant
      id="saved-headers"
      title="Saved Headers"
    >
      <div>
        <ProviderHeadersInput v-model="savedHeaders" />
      </div>
    </Variant>
  </Story>
</template>
