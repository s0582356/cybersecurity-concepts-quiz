<script setup>
import { computed } from 'vue'
import { batchStatusLabel, resultSeverity } from '../storage/catalogImport.js'
import { t } from '../i18n/index.js'

const props = defineProps({
  report: { type: Object, required: true },
})

defineEmits(['confirm-update'])

const number = (value) => value.toLocaleString(t('import.numberLocale') === 'en' ? 'en-US' : 'de-DE')
const summaryParts = computed(() => {
  const { summary } = props.report

  return [
    t('import.summary.files', { count: number(summary.filesChecked) }),
    t('import.summary.libraries', { count: number(summary.librariesRecognized) }),
    t('import.summary.sections', { count: number(summary.sectionsRecognized) }),
    t('import.summary.questions', { count: number(summary.activeQuestions) }),
  ]
})

// Sprachhinweise nur bei Libraries mit Englisch-Bezug (deklariert oder tatsächlich vorhanden).
function languageLine(languages) {
  if (!languages || (languages.en === 0 && !languages.declaresEnglish)) {
    return null
  }

  return languages.en === languages.de
    ? t('import.language.enComplete', { total: languages.de })
    : t('import.language.en', { en: languages.en, total: languages.de })
}
</script>

<template>
  <section class="import-report" :aria-label="t('import.report.label')">
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
        <span class="import-status">{{ t(batchStatusLabel(result.status)) }}</span>
        <span v-if="result.message" class="import-detail">{{ t(result.message) }}</span>
        <span v-if="languageLine(result.languages)" class="import-language">{{ languageLine(result.languages) }}</span>
        <span v-for="note in result.languages?.notes ?? []" :key="note.i18n" class="import-detail">{{ t(note) }}</span>
        <button
          v-if="report.pendingLibraryIds.includes(result.libraryId) && ['updatePending', 'replacementPending'].includes(result.status)"
          class="start-button"
          type="button"
          @click="$emit('confirm-update', result.libraryId)"
        >
          {{ t('import.confirmUpdate') }}
        </button>
      </li>
    </ul>
  </section>
</template>
