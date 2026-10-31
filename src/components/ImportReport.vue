<script setup>
import { computed } from 'vue'
import { BATCH_STATUS_LABEL, resultSeverity } from '../storage/catalogImport.js'

const props = defineProps({
  report: { type: Object, required: true },
})

defineEmits(['confirm-update'])

const number = (value) => value.toLocaleString('de-DE')
const summaryParts = computed(() => {
  const { summary } = props.report

  return [
    `${number(summary.filesChecked)} Dateien geprüft`,
    `${number(summary.librariesRecognized)} Libraries erkannt`,
    `${number(summary.sectionsRecognized)} Lernabschnitte`,
    `${number(summary.activeQuestions)} aktive Fragen`,
  ]
})
</script>

<template>
  <section class="import-report" aria-label="Import-Ergebnis">
    <p v-if="report.summary.librariesRecognized > 0 || report.summary.filesChecked > 1" class="import-summary">
      {{ summaryParts.join(' · ') }}
    </p>

    <ul class="import-results">
      <li
        v-for="result in report.results"
        :key="result.fileName + (result.libraryId ?? '')"
        class="library-message"
        :class="`library-message-${resultSeverity(result.status)}`"
        :role="resultSeverity(result.status) === 'error' ? 'alert' : 'status'"
      >
        <strong>{{ result.fileName }}</strong>
        <span class="import-status">{{ BATCH_STATUS_LABEL[result.status] }}</span>
        <span v-if="result.message" class="import-detail">{{ result.message }}</span>
        <button
          v-if="report.pendingLibraryIds.includes(result.libraryId) && ['updatePending', 'replacementPending'].includes(result.status)"
          class="start-button"
          type="button"
          @click="$emit('confirm-update', result.libraryId)"
        >
          Aktualisierung übernehmen
        </button>
      </li>
    </ul>
  </section>
</template>
