<script setup>
import { computed, ref, useId } from 'vue'
import { sectionNumber } from '../domain/libraryCatalog.js'
import { batchStatusLabel, resultSeverity } from '../storage/catalogImport.js'
import { t } from '../i18n/index.js'

// Darstellung des Import-Ergebnisses. Erfolg kompakt (Zusammenfassung, Details und Dateiliste einklappbar), Fehler prominent
// und immer sichtbar. Rein darstellend: Importlogik, Validierung und Persistenz liegen unverändert in App/catalogImport.
const props = defineProps({
  report: { type: Object, required: true },
})

defineEmits(['confirm-update'])

const uid = useId()
const detailsId = `${uid}-details`
const filesId = `${uid}-files`
const detailsOpen = ref(false)
const filesOpen = ref(false)

const number = (value) => value.toLocaleString(t('import.numberLocale') === 'en' ? 'en-US' : 'de-DE')
// Die Pluralform richtet sich nach der Zahl (count), angezeigt wird die formatierte Zahl (display, z. B. 1.179).
const counted = (value) => ({ count: value, display: number(value) })
const isOk = (result) => resultSeverity(result.status) === 'info'
// Allgemeine Standardmeldungen für "neu"/"bekannt" wiederholen nur den Status und entfallen in der kompakten Zeile.
const REDUNDANT_MESSAGES = ['result.new', 'result.known']

const results = computed(() => props.report.results)
const problems = computed(() => results.value.filter((result) => !isOk(result)))
// Ausstehende Updates sind kein Fehlschlag, sondern warten auf die Bestätigung: dann neutrale Überschrift.
const PENDING = ['updatePending', 'replacementPending']
const problemsTitle = computed(() =>
  t(problems.value.some((result) => PENDING.includes(result.status)) ? 'import.problems.titleAttention' : 'import.problems.title', {
    count: problems.value.length,
  }),
)
const okResults = computed(() => results.value.filter(isOk))
const showSummary = computed(() => props.report.summary.librariesRecognized > 0 || props.report.summary.filesChecked > 1)
const libraryResults = computed(() => okResults.value.filter((result) => result.languages && result.languages.de > 0))

const summaryParts = computed(() => {
  const { summary } = props.report

  return [
    t('import.summary.files', counted(summary.filesChecked)),
    t('import.summary.libraries', counted(summary.librariesRecognized)),
    t('import.summary.sections', counted(summary.sectionsRecognized)),
    t('import.summary.questions', counted(summary.activeQuestions)),
  ]
})

// "Deutsch ✓ · English ✓" nur aus den tatsächlich importierten Fassungen; unvollständiges Englisch wird mit Zahlen genannt.
const languageSummary = computed(() => {
  if (libraryResults.value.length === 0) {
    return null
  }

  const total = libraryResults.value.reduce((sum, result) => sum + result.languages.de, 0)
  const english = libraryResults.value.reduce((sum, result) => sum + result.languages.en, 0)
  const parts = [t('import.languages.de')]

  if (english === total) {
    parts.push(t('import.languages.en'))
  } else if (english > 0) {
    parts.push(t('import.language.en', { en: english, total }))
  }

  return parts.join(' · ')
})

const noteCount = computed(() => okResults.value.filter((result) => (result.languages?.notes?.length ?? 0) > 0).length)

// Zusammenfassung je Lernabschnitt (aus den Ergebnissen der Import-Dateien, aufsteigend nach Abschnittsnummer).
const sectionRows = computed(() => {
  const sections = new Map()

  libraryResults.value.forEach((result) => {
    if (!result.learningSectionId) {
      return
    }

    const row = sections.get(result.learningSectionId) ?? { id: result.learningSectionId, libraries: 0, questions: 0 }

    row.libraries += 1
    row.questions += result.languages.de
    sections.set(result.learningSectionId, row)
  })

  return [...sections.values()].sort((left, right) => Number(sectionNumber(left.id)) - Number(sectionNumber(right.id)) || left.id.localeCompare(right.id))
})

// Kompakte Dateizeile: Status · Fragen · Englisch.
function fileExtras(result) {
  const parts = []
  const { languages } = result

  if (languages?.de > 0) {
    parts.push(t('import.file.questions', { count: languages.de }))
  }

  if (languages && (languages.en > 0 || languages.declaresEnglish)) {
    parts.push(languages.en === languages.de ? t('import.file.enComplete') : t('import.language.en', { en: languages.en, total: languages.de }))
  }

  return parts.join(' · ')
}

const shownMessage = (result) => (result.message && !REDUNDANT_MESSAGES.includes(result.message.i18n) ? result.message : null)
const canConfirm = (result) =>
  props.report.pendingLibraryIds.includes(result.libraryId) && PENDING.includes(result.status)
</script>

<template>
  <section class="import-report" :aria-label="t('import.report.label')">
    <div v-if="problems.length > 0" class="import-problems" role="alert">
      <p class="import-problems-title">
        <span aria-hidden="true">⚠</span>
        {{ problemsTitle }}
      </p>
      <ul class="import-problem-list">
        <li
          v-for="result in problems"
          :key="result.fileName + (result.libraryId ?? '')"
          class="library-message library-message-error import-problem"
        >
          <strong class="import-file-name">{{ result.fileName }}</strong>
          <span class="import-status">{{ t(batchStatusLabel(result.status)) }}</span>
          <span v-if="result.message" class="import-detail">{{ t('import.problems.reason') }} {{ t(result.message) }}</span>
          <button v-if="canConfirm(result)" class="start-button" type="button" @click="$emit('confirm-update', result.libraryId)">
            {{ t('import.confirmUpdate') }}
          </button>
        </li>
      </ul>
    </div>

    <div v-if="okResults.length > 0 || showSummary" class="import-compact">
      <p v-if="okResults.length > 0" class="import-success" role="status">
        <span aria-hidden="true">✓</span>
        {{ t(problems.length > 0 ? 'import.partial' : 'import.success') }}
      </p>
      <p v-if="showSummary" class="import-summary">{{ summaryParts.join(' · ') }}</p>
      <p v-if="languageSummary && okResults.length > 0" class="import-languages">{{ languageSummary }}</p>
      <p v-if="noteCount > 0 && okResults.length > 0" class="import-hints" role="status">
        <span aria-hidden="true">ℹ</span>
        {{ t('import.hints', { count: noteCount }) }}
      </p>

      <template v-if="okResults.length > 0">
        <button
          class="secondary-button import-toggle"
          type="button"
          data-import="details-toggle"
          :aria-expanded="detailsOpen"
          :aria-controls="detailsId"
          @click="detailsOpen = !detailsOpen"
        >
          {{ t(detailsOpen ? 'import.details.hide' : 'import.details.show') }}
        </button>

        <div :id="detailsId" class="import-details" data-import="details" :hidden="!detailsOpen">
          <ul class="import-sections" :aria-label="t('import.sections.label')">
            <li v-for="row in sectionRows" :key="row.id" class="import-section-row">
              <span aria-hidden="true">✓</span>
              {{ t('section.label', { id: sectionNumber(row.id) }) }} · {{ t('import.section.libraries', { count: row.libraries }) }} ·
              {{ t('import.section.questions', { count: row.questions }) }}
            </li>
          </ul>

          <button
            class="secondary-button import-toggle"
            type="button"
            data-import="files-toggle"
            :aria-expanded="filesOpen"
            :aria-controls="filesId"
            @click="filesOpen = !filesOpen"
          >
            {{ t(filesOpen ? 'import.files.hide' : 'import.files.show', { count: results.length }) }}
          </button>

          <ul :id="filesId" class="import-results" data-import="files" :hidden="!filesOpen">
            <li v-for="result in results" :key="result.fileName + (result.libraryId ?? '')" class="import-file" :class="`import-file-${isOk(result) ? 'ok' : 'problem'}`">
              <span class="import-file-mark" aria-hidden="true">{{ isOk(result) ? '✓' : '⚠' }}</span>
              <span class="import-file-body">
                <strong class="import-file-name">{{ result.fileName }}</strong>
                <span class="import-file-meta">
                  <span class="import-status">{{ t(batchStatusLabel(result.status)) }}</span>
                  <template v-if="fileExtras(result)"> · {{ fileExtras(result) }}</template>
                </span>
                <span v-if="shownMessage(result)" class="import-detail">{{ t(shownMessage(result)) }}</span>
                <span v-for="note in result.languages?.notes ?? []" :key="note.i18n" class="import-detail">{{ t(note) }}</span>
              </span>
            </li>
          </ul>
        </div>
      </template>
    </div>
  </section>
</template>
