<script setup lang="ts">
import { FieldKeyValues } from '@proj-airi/ui'
import { isEqual } from 'es-toolkit'
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

interface HeaderRow {
  key: string
  value: string
}

/**
 * Custom HTTP headers that the provider adds to each request.
 * The input saves rows that have a key. Undefined means that the user has not added a header.
 */
const headers = defineModel<Record<string, string> | undefined>({ required: true })

const { t } = useI18n()
const emptyHeaders: Readonly<Record<string, string>> = Object.freeze({})

/** Adds the empty row that the user types a new header into. */
function rowsOf(value: Record<string, string> | undefined): HeaderRow[] {
  return [...Object.entries(value ?? emptyHeaders).map(([key, value]) => ({ key, value })), { key: '', value: '' }]
}

function headersOf(rows: HeaderRow[]): Record<string, string> {
  return Object.fromEntries(rows
    .filter(row => row.key.trim().length > 0)
    .map(row => [row.key.trim(), row.value]))
}

// The rows are the edit state. A row without a key is not saved, so a reload from the
// saved headers would delete the row that the user types into. Reload only on outside changes.
const rows = ref<HeaderRow[]>(rowsOf(headers.value))

watch(headers, (value) => {
  if (!isEqual(value ?? emptyHeaders, headersOf(rows.value)))
    rows.value = rowsOf(value)
}, { deep: true })

watch(rows, (current) => {
  const lastRow = current.at(-1)
  if (!lastRow || lastRow.key.length > 0 || lastRow.value.length > 0) {
    rows.value = [...current, { key: '', value: '' }]
    return
  }

  const next = headersOf(current)
  if (!isEqual(headers.value ?? emptyHeaders, next))
    headers.value = next
}, { deep: true })

function removeRow(index: number) {
  const remaining = rows.value.filter((_, rowIndex) => rowIndex !== index)
  rows.value = remaining.length > 0 ? remaining : rowsOf(undefined)
}
</script>

<template>
  <FieldKeyValues
    v-model="rows"
    :label="t('settings.pages.providers.common.section.advanced.fields.field.headers.label')"
    :description="t('settings.pages.providers.common.section.advanced.fields.field.headers.description')"
    :key-placeholder="t('settings.pages.providers.common.section.advanced.fields.field.headers.key.placeholder')"
    :value-placeholder="t('settings.pages.providers.common.section.advanced.fields.field.headers.value.placeholder')"
    :required="false"
    @remove="removeRow"
  />
</template>
