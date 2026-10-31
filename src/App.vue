<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import QuizCard from './components/QuizCard.vue'
import ScoreBox from './components/ScoreBox.vue'
import PrivateQuestionImporter from './components/PrivateQuestionImporter.vue'
import ImportReport from './components/ImportReport.vue'
import SectionOverview from './components/SectionOverview.vue'
import sampleQuestions from './data/public/sampleQuestions.json'
import { BATCH_STATUS, planLibraryBatch, summarizeBatch } from './domain/libraryCatalog.js'
import {
  SESSION_STATUS,
  applyOptionOrder,
  evaluateSession,
  isValidOptionOrder,
  optionOrderOf,
  shuffled,
} from './domain/session.js'
import { createSectionSessionRecord } from './domain/sectionSession.js'
import { DB_NAME, createProgressStore } from './storage/progressStore.js'
import { confirmPendingUpdate, importLibraryBatch } from './storage/catalogImport.js'
import { buildOverview, buildSectionView, readCatalogData, readSectionData } from './storage/sectionService.js'

const questions = ref(sampleQuestions)
const questionBankName = ref('Öffentliche Beispiel-Fragen')
const isQuizStarted = ref(false)
const isQuizComplete = ref(false)
const isReviewMode = ref(false)
const originalQuestions = ref(sampleQuestions)
const currentQuestionIndex = ref(0)
const selectedAnswer = ref(null)
const isAnswered = ref(false)
const score = ref(0)
const currentStreak = ref(0)
const bestStreak = ref(0)
const incorrectlyAnsweredQuestions = ref([])
const answeredQuestions = ref([])

// V2-Persistenz (Phase 2A): Fortschritt je (libraryId, question.id) in IndexedDB.
// V1-Banken bleiben ohne Persistenz.
const progressStore = createProgressStore()
// Phase 2E: Katalog (Lernabschnitte) und der aktuell geöffnete Lernabschnitt.
const catalog = ref({ sections: [], uncatalogedLibraryIds: [] })
const activeSection = ref(null)
const importReport = ref(null)
const importMessage = ref(null)
const persistenceWarning = ref('')
const librarySummary = ref(null)
// Phase 2B: Resume-Zustand der V2-Lernrunde (getrennt vom dauerhaften Question Progress).
const sessionInfo = ref(null)
// Phase 2D: Ersetzungs-Index (nur IDs und Policies; wird lokal geladen, nie im Repo mitgeliefert).
const retiredIndex = ref(null)
const activeSessionId = ref(null)
let storageReady = null
let storageError = ''
let pendingWrites = Promise.resolve()
// Phase 2E: erkannte, noch nicht bestätigte Updates (mit Fragen) – bewusst nicht reaktiv.
let pendingEntries = new Map()
// Ohne verfügbaren Speicher: flüchtiger Katalog nur für diese Sitzung.
let memoryEntries = new Map()
let catalogToken = 0

const hasCatalog = computed(() => catalog.value.sections.length > 0)
const totalQuestions = computed(() => questions.value.length)
const wrongAnswerCount = computed(() => totalQuestions.value - score.value)
const scorePercentage = computed(() => {
  if (totalQuestions.value === 0) {
    return 0
  }

  return Math.round((score.value / totalQuestions.value) * 100)
})

const currentQuestion = computed(() => {
  return questions.value[currentQuestionIndex.value]
})

const isLastQuestion = computed(() => {
  return currentQuestionIndex.value === totalQuestions.value - 1
})

const resultMessage = computed(() => {
  if (scorePercentage.value >= 90) {
    return 'Security+ Ready'
  }

  if (scorePercentage.value >= 75) {
    return 'Prüfungsnah – sehr gut'
  }

  if (scorePercentage.value >= 60) {
    return 'Solide Basis – wiederholen lohnt sich'
  }

  return 'Noch unsicher – Fehlerfragen wiederholen'
})

const categoryResults = computed(() => {
  const categories = new Map()

  answeredQuestions.value.forEach((answer) => {
    const categoryName = answer.category || 'Allgemein'

    if (!categories.has(categoryName)) {
      categories.set(categoryName, {
        name: categoryName,
        correct: 0,
        total: 0,
      })
    }

    const category = categories.get(categoryName)
    category.total++

    if (answer.isCorrect) {
      category.correct++
    }
  })

  return [...categories.values()]
    .map((category) => {
      const percentage = Math.round((category.correct / category.total) * 100)
      let label = 'Wiederholen'
      let statusClass = 'category-review'

      if (percentage >= 80) {
        label = 'Stark'
        statusClass = 'category-strong'
      } else if (percentage >= 60) {
        label = 'Solide'
        statusClass = 'category-solid'
      }

      return {
        ...category,
        percentage,
        label,
        statusClass,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
})

const weakCategories = computed(() => {
  return categoryResults.value
    .filter((category) => category.percentage < 60)
    .map((category) => category.name)
})

const learningRecommendation = computed(() => {
  if (weakCategories.value.length > 0) {
    return `Wiederhole besonders: ${weakCategories.value.join(', ')}`
  }

  return 'Keine klare Schwachstelle in diesem Durchlauf.'
})

function getQuestionKey(question) {
  if (question.libraryId) {
    return `${question.libraryId}::${question.id}`
  }

  return [
    question.id,
    question.category,
    question.difficulty,
    question.question,
  ]
    .filter(Boolean)
    .join('::')
}

function shuffleOptions(options = []) {
  const shuffledOptions = [...options]

  for (let index = shuffledOptions.length - 1; index > 0; index--) {
    const randomIndex = Math.floor(Math.random() * (index + 1))
    const currentOption = shuffledOptions[index]
    shuffledOptions[index] = shuffledOptions[randomIndex]
    shuffledOptions[randomIndex] = currentOption
  }

  return shuffledOptions
}

function shuffleOptionsForQuestions(questionList) {
  return questionList.map((question) => ({
    ...question,
    options: shuffleOptions(question.options),
  }))
}

function resetQuizProgress({ clearIncorrectAnswers = true } = {}) {
  currentQuestionIndex.value = 0
  selectedAnswer.value = null
  isAnswered.value = false
  score.value = 0
  currentStreak.value = 0
  bestStreak.value = 0
  answeredQuestions.value = []
  isQuizComplete.value = false

  if (clearIncorrectAnswers) {
    incorrectlyAnsweredQuestions.value = []
  }
}

function startQuiz() {
  if (activeSection.value) {
    return startLearningSession()
  }

  questions.value = shuffleOptionsForQuestions(originalQuestions.value)
  isReviewMode.value = false
  resetQuizProgress()
  isQuizStarted.value = true
}

function optionKeyOf(question, option) {
  return Object.keys(question.optionTextByKey ?? {}).find((key) => question.optionTextByKey[key] === option) ?? null
}

// Neue V2-Lernrunde: Reihenfolge wird einmal erzeugt und persistiert (kein Neu-Shuffle beim Reload).
// Ersetzt eine vorhandene Session der Bibliothek; dauerhafter Question Progress bleibt erhalten.
async function startLearningSession() {
  const orderedQuestions = shuffled(shuffleOptionsForQuestions(originalQuestions.value))
  activeSessionId.value = null
  await pendingWrites

  // Eine Runde gehört zum ganzen Lernabschnitt: Fragen aller zugehörigen Libraries, einmal gemischt.
  if (activeSection.value && !activeSection.value.ephemeral && (await storageReady)) {
    try {
      const session = createSectionSessionRecord({
        sectionId: activeSection.value.sectionId,
        libraries: activeSection.value.libraries,
        orderedQuestions,
        optionOrder: optionOrderOf(orderedQuestions[0]),
      })

      await progressStore.startNewSession(session)
      activeSessionId.value = session.sessionId
    } catch (error) {
      persistenceWarning.value = `Lernrunde wird nicht gespeichert: ${error.message}`
    }
  }

  questions.value = orderedQuestions
  isReviewMode.value = false
  resetQuizProgress()
  sessionInfo.value = null
  isQuizStarted.value = true
}

async function resumeLearningSession() {
  const info = sessionInfo.value

  if (info?.status !== SESSION_STATUS.RESUMABLE) {
    return
  }

  const { session } = info
  const restoredOrder = info.currentState?.optionOrder
  const resumedQuestions = info.orderedQuestions.map((question) => {
    if (question.id === info.currentQuestionId && isValidOptionOrder(restoredOrder)) {
      return applyOptionOrder(question, restoredOrder)
    }

    return { ...question, options: shuffleOptions(question.options) }
  })
  const questionsById = new Map(resumedQuestions.map((question) => [question.id, question]))
  const correctIds = new Set(session.correctQuestionIds)

  questions.value = resumedQuestions
  isReviewMode.value = false
  resetQuizProgress()

  answeredQuestions.value = session.answeredQuestionIds.map((id) => {
    const question = questionsById.get(id)

    return {
      key: getQuestionKey(question),
      category: question.category || 'Allgemein',
      isCorrect: correctIds.has(id),
    }
  })
  incorrectlyAnsweredQuestions.value = session.answeredQuestionIds
    .filter((id) => !correctIds.has(id))
    .map((id) => questionsById.get(id))
  score.value = info.stats.correctCount
  currentStreak.value = session.currentStreak ?? 0
  bestStreak.value = session.bestSessionStreak ?? 0
  currentQuestionIndex.value = info.currentIndex

  if (session.answeredQuestionIds.includes(info.currentQuestionId)) {
    const current = questionsById.get(info.currentQuestionId)
    const key = info.currentState?.selectedOptionKey

    isAnswered.value = true
    // Ohne gespeicherte Auswahl (z. B. Frage seit der Antwort überarbeitet) wird nur das
    // Ergebnis gezeigt, nie eine alte Auswahl als aktuelle dargestellt.
    selectedAnswer.value = key
      ? (current.optionTextByKey?.[key] ?? null)
      : correctIds.has(info.currentQuestionId)
        ? current.correctAnswer
        : null
  }

  activeSessionId.value = session.sessionId
  sessionInfo.value = null
  isQuizStarted.value = true

  const sessionId = session.sessionId
  queueWrite(() => progressStore.markSessionResumed(sessionId), 'Lernrunde konnte nicht aktualisiert werden')
}

function selectAnswer(option) {
  if (isAnswered.value) {
    return
  }

  selectedAnswer.value = option
  isAnswered.value = true

  const isCorrect = option === currentQuestion.value.correctAnswer

  answeredQuestions.value.push({
    key: getQuestionKey(currentQuestion.value),
    category: currentQuestion.value.category || 'Allgemein',
    isCorrect,
  })

  persistAnswer(currentQuestion.value, isCorrect, option)

  if (isCorrect) {
    score.value++
    currentStreak.value++
    bestStreak.value = Math.max(bestStreak.value, currentStreak.value)
    return
  }

  currentStreak.value = 0

  const alreadyTracked = incorrectlyAnsweredQuestions.value.some((question) => {
    return getQuestionKey(question) === getQuestionKey(currentQuestion.value)
  })

  if (!alreadyTracked) {
    incorrectlyAnsweredQuestions.value.push(currentQuestion.value)
  }
}

function nextQuestion() {
  if (isLastQuestion.value) {
    return
  }

  currentQuestionIndex.value++
  selectedAnswer.value = null
  isAnswered.value = false

  // Erst beim tatsächlichen Wechsel ändern sich currentQuestionId/currentIndex im Storage.
  if (activeSessionId.value && !isReviewMode.value) {
    const sessionId = activeSessionId.value
    const next = currentQuestion.value

    queueWrite(
      () =>
        progressStore.advanceSessionTo({
          sessionId,
          questionId: next.id,
          optionOrder: optionOrderOf(next),
        }),
      'Lernrunde konnte nicht gespeichert werden',
    )
  }
}

function finishQuiz() {
  isQuizComplete.value = true

  if (activeSessionId.value && !isReviewMode.value) {
    const sessionId = activeSessionId.value

    activeSessionId.value = null
    queueWrite(
      () => progressStore.completeSessionById(sessionId),
      'Lernrunde konnte nicht abgeschlossen werden',
    )
  }
}

function restartWithCurrentQuestionBank() {
  if (activeSection.value) {
    return startLearningSession()
  }

  questions.value = shuffleOptionsForQuestions(originalQuestions.value)
  isReviewMode.value = false
  resetQuizProgress()
  isQuizStarted.value = true
}

function repeatIncorrectQuestions() {
  if (incorrectlyAnsweredQuestions.value.length === 0) {
    return
  }

  questions.value = shuffleOptionsForQuestions(incorrectlyAnsweredQuestions.value)
  isReviewMode.value = true
  resetQuizProgress()
  isQuizStarted.value = true
}

function showQuestionBankSelection() {
  questions.value = originalQuestions.value
  isReviewMode.value = false
  isQuizStarted.value = false
  activeSessionId.value = null
  resetQuizProgress()
  refreshSection()
  refreshCatalog()
}

function ensureStorage() {
  if (!storageReady) {
    storageReady = progressStore
      .initialize()
      .then(async () => {
        retiredIndex.value = await progressStore.getRetiredIndex()

        return true
      })
      .catch((error) => {
        storageError = error.message
        persistenceWarning.value = `Fortschritt wird nicht gespeichert: ${error.message}`
        return false
      })
  }

  return storageReady
}

// Schreibaufträge laufen nacheinander (Antwort → Weiter → Abschluss behalten ihre Reihenfolge).
function queueWrite(task, failureMessage) {
  pendingWrites = pendingWrites
    .then(async () => {
      if (await storageReady) {
        await task()
      }
    })
    .catch((error) => {
      persistenceWarning.value = `${failureMessage}: ${error.message}`
    })
}

function persistAnswer(question, isCorrect, option) {
  if (!question.libraryId || !activeSection.value) {
    return
  }

  const sessionId = isReviewMode.value ? null : activeSessionId.value
  const answer = {
    libraryId: question.libraryId,
    questionId: question.id,
    isCorrect,
    // Revision, bei der geantwortet wurde (nur Information, keine Wertungsregel).
    answeredAtRevision: question.contentRevision ?? null,
  }

  queueWrite(async () => {
    // Antwort und Rundenstand werden gemeinsam in einer Transaktion geschrieben.
    if (sessionId) {
      const result = await progressStore.recordSessionAnswer({
        ...answer,
        sessionId,
        selectedOptionKey: optionKeyOf(question, option),
        optionOrder: optionOrderOf(question),
      })

      if (result.recorded || !['noSession', 'unknownQuestion'].includes(result.reason)) {
        return
      }
    }

    await progressStore.recordAnswer(answer)
  }, 'Fortschritt konnte nicht gespeichert werden')
}

const sessionPanel = computed(() => {
  const info = sessionInfo.value

  if (!info || info.status === SESSION_STATUS.NONE) {
    return null
  }

  if (info.status === SESSION_STATUS.COMPLETED) {
    return {
      title: 'Lernrunde abgeschlossen',
      text: `Letzte Runde: ${info.stats.correctCount} richtig, ${info.stats.incorrectCount} falsch von ${info.stats.totalCount} Fragen.`,
      discardLabel: 'Neue Runde starten',
    }
  }

  if (info.status === SESSION_STATUS.RESUMABLE) {
    const { stats } = info
    const newQuestions =
      info.newQuestionCount > 0
        ? ` · ${info.newQuestionCount} neue Fragen im Lernabschnitt kommen erst ab der nächsten Runde dazu`
        : ''

    return {
      title: 'Lernrunde läuft',
      text:
        `Frage ${info.currentIndex + 1} von ${stats.totalCount} · ${stats.answeredCount} beantwortet · ` +
        `${stats.correctCount} richtig · ${stats.incorrectCount} falsch · ${stats.remainingCount} offen${newQuestions}`,
      discardLabel: 'Aktuelle Runde verwerfen und neu starten',
    }
  }

  const reasons = {
    questionsChanged: `Die Fragen dieses Lernabschnitts passen nicht zur gespeicherten Runde (${info.missingQuestionIds?.length ?? 0} fehlen).`,
    revisionsChanged: `${info.revisedQuestionIds?.length ?? 0} Fragen wurden seit Rundenstart überarbeitet.`,
    currentQuestionMissing: 'Die gespeicherte Position ist nicht auffindbar.',
    invalidSession: 'Die gespeicherte Runde ist nicht lesbar.',
  }

  return {
    title: 'Lernrunde kann nicht fortgesetzt werden',
    text:
      `${reasons[info.reason]} Diese Runde kann nicht mehr angepasst werden und lässt sich nur ` +
      'verwerfen und neu starten. Sie bleibt bis dahin gespeichert; ' +
      'dein dauerhafter Fortschritt ist nicht betroffen.',
    discardLabel: 'Runde verwerfen und neu starten',
  }
})

async function storageAvailable() {
  return Boolean(storageReady) && (await storageReady)
}

// Katalog (Lernabschnitts-Karten) neu aus dem Speicher ableiten. Ältere Antworten werden verworfen.
async function refreshCatalog() {
  const token = ++catalogToken
  let next = { sections: [], uncatalogedLibraryIds: [] }

  await pendingWrites

  try {
    if (memoryEntries.size > 0) {
      next = buildOverview({ states: memoryStates(), progress: [], sessions: [] })
    } else if (await storageAvailable()) {
      next = buildOverview(await readCatalogData(progressStore))
    }
  } catch (error) {
    persistenceWarning.value = `Bibliothek konnte nicht gelesen werden: ${error.message}`
  }

  if (token === catalogToken) {
    catalog.value = next
  }
}

function memoryStates() {
  return [...memoryEntries.values()].map(({ library }) => library)
}

function memorySectionData(sectionId) {
  const entries = [...memoryEntries.values()].filter(({ library }) => library.learningSectionId === sectionId)

  return {
    sectionId,
    states: entries.map(({ library }) => library),
    contents: entries.map(({ library, questions: entryQuestions }) => ({
      activeQuestionIndexHash: library.activeQuestionIndexHash,
      questions: entryQuestions,
    })),
    progress: [],
    session: null,
  }
}

// Lädt den Lernabschnitt (Fragen aller zugehörigen Libraries, Fortschritt, Rundenstand) aus dem Speicher.
// Rückgabe false, wenn der Abschnitt nicht geöffnet werden kann.
async function refreshSection(sectionId = activeSection.value?.sectionId) {
  if (!sectionId) {
    return false
  }

  await pendingWrites

  let data

  try {
    if (memoryEntries.size > 0) {
      data = memorySectionData(sectionId)
    } else if (await storageAvailable()) {
      data = await readSectionData(progressStore, sectionId)
    } else {
      return false
    }
  } catch (error) {
    persistenceWarning.value = `Lernabschnitt konnte nicht gelesen werden: ${error.message}`
    return false
  }

  const view = buildSectionView(data)

  if (view.error) {
    activeSection.value = null
    librarySummary.value = null
    sessionInfo.value = null
    importMessage.value = { type: 'error', text: `${view.label}: ${view.error}` }
    return false
  }

  activeSection.value = {
    sectionId,
    label: view.label,
    libraries: view.libraries,
    ephemeral: memoryEntries.size > 0,
  }
  originalQuestions.value = view.questions
  questionBankName.value = view.label
  librarySummary.value = view.summary
  sessionInfo.value = view.evaluation

  return true
}

async function openSection(sectionId) {
  importMessage.value = null
  activeSessionId.value = null

  if (!(await refreshSection(sectionId))) {
    return
  }

  questions.value = shuffleOptionsForQuestions(originalQuestions.value)
  isReviewMode.value = false
  isQuizStarted.value = false
  resetQuizProgress()
}

async function initializeCatalog() {
  const factory = globalThis.indexedDB

  if (!factory) {
    return
  }

  // Reine V1-Nutzung legt keine Datenbank an: nur öffnen, wenn es schon eine gibt.
  if (typeof factory.databases === 'function') {
    try {
      const databases = await factory.databases()

      if (!databases.some((database) => database.name === DB_NAME)) {
        return
      }
    } catch {
      // Unbekannt: normal weitermachen.
    }
  }

  if (await ensureStorage()) {
    await refreshCatalog()
  }
}

function loadV1Bank({ questions: importedQuestions, fileName }) {
  activeSection.value = null
  activeSessionId.value = null
  librarySummary.value = null
  sessionInfo.value = null
  originalQuestions.value = importedQuestions
  questions.value = shuffleOptionsForQuestions(importedQuestions)
  questionBankName.value = `Private Fragebank: ${fileName}`
  isReviewMode.value = false
  isQuizStarted.value = false
  resetQuizProgress()
}

// Ohne Speicher: Libraries gelten nur für diese Sitzung (kein Fortschritt, keine Rundenspeicherung).
async function importWithoutStorage(entries) {
  const plan = planLibraryBatch(entries)
  const results = [...plan.results]

  plan.importable.forEach((entry) => {
    memoryEntries.set(entry.library.libraryId, entry)
    results.push({
      fileName: entry.fileName,
      libraryId: entry.library.libraryId,
      title: entry.library.title,
      learningSectionId: entry.library.learningSectionId,
      status: BATCH_STATUS.NEW,
      message: 'Nur für diese Sitzung geladen, da der lokale Speicher nicht verfügbar ist.',
    })
  })

  importReport.value = {
    results: results.sort((a, b) => a.fileName.localeCompare(b.fileName)),
    summary: summarizeBatch(entries, plan.importable),
    pendingLibraryIds: [],
  }
  persistenceWarning.value = `Fortschritt wird nicht gespeichert: ${storageError || 'Speicher nicht verfügbar.'}`
  await refreshCatalog()
}

async function importBatch(entries) {
  const needsStorage = entries.some((entry) => entry.kind === 'v2' || entry.kind === 'retiredIndex')

  if (!needsStorage) {
    // Nur ungültige/V1-Dateien im Batch: es gibt nichts zu speichern, nur zu berichten.
    importReport.value = {
      results: planLibraryBatch(entries).results.sort((a, b) => a.fileName.localeCompare(b.fileName)),
      summary: summarizeBatch(entries, []),
      pendingLibraryIds: [],
    }
    return
  }

  if (!(await ensureStorage())) {
    await importWithoutStorage(entries)
    return
  }

  try {
    const batch = await importLibraryBatch(progressStore, entries, { retiredIndex: retiredIndex.value })

    retiredIndex.value = batch.retiredIndex
    pendingEntries = batch.pending
    importReport.value = {
      results: batch.results,
      summary: batch.summary,
      pendingLibraryIds: [...batch.pending.keys()],
    }
  } catch (error) {
    persistenceWarning.value = `Fortschritt wird nicht gespeichert: ${error.message}`
    return
  }

  await refreshCatalog()
  await refreshSection()
}

async function handleFilesLoaded(entries) {
  importMessage.value = null
  persistenceWarning.value = ''
  importReport.value = null
  pendingEntries = new Map()

  if (entries.length === 1 && entries[0].kind === 'v1') {
    loadV1Bank(entries[0])
    return
  }

  await importBatch(entries)
}

// Bewusste Entscheidung des Nutzers: kompatible Änderung übernehmen (Fortschritt bleibt, nichts wird kopiert).
async function confirmLibraryUpdate(libraryId) {
  const entry = pendingEntries.get(libraryId)

  if (!entry) {
    return
  }

  const setResult = (changes) => {
    pendingEntries.delete(libraryId)
    importReport.value = {
      ...importReport.value,
      results: importReport.value.results.map((result) =>
        result.libraryId === libraryId ? { ...result, ...changes } : result,
      ),
      pendingLibraryIds: [...pendingEntries.keys()],
    }
  }

  try {
    await pendingWrites
    await confirmPendingUpdate(progressStore, entry, { retiredIndex: retiredIndex.value })
  } catch (error) {
    setResult({ status: BATCH_STATUS.REJECTED, message: `Aktualisierung nicht möglich: ${error.message}` })
    return
  }

  setResult({
    status: BATCH_STATUS.VERSION_UPDATED,
    message: `Bibliothek auf Version ${entry.library.libraryVersion} aktualisiert. Dein Fortschritt bleibt erhalten.`,
  })
  await refreshCatalog()
  await openSection(entry.library.learningSectionId)
}

onMounted(initializeCatalog)
onBeforeUnmount(() => progressStore.close())
</script>

<template>
  <main class="app-shell">
    <section class="hero-section">
      <p class="eyebrow">Cybersecurity Concepts Quiz</p>
      <h1>Trainiere wichtige Security-Grundlagen</h1>
      <p class="intro">
        Eine kleine Vue.js-Lern-App mit neutralen Beispiel-Fragen zu allgemeinen
        Cybersecurity-Konzepten.
      </p>
      <p class="question-bank-label">{{ questionBankName }}</p>
      <p v-if="isReviewMode" class="review-mode-label">Wiederholung falscher Fragen</p>
    </section>

    <section v-if="!isQuizStarted" class="start-layout" aria-label="Quiz vorbereiten">
      <PrivateQuestionImporter :empty="!hasCatalog" @files-loaded="handleFilesLoaded" />

      <p
        v-if="importMessage"
        class="library-message"
        :class="`library-message-${importMessage.type}`"
        role="status"
      >
        {{ importMessage.text }}
      </p>
      <ImportReport v-if="importReport" :report="importReport" @confirm-update="confirmLibraryUpdate" />
      <p v-if="persistenceWarning" class="library-message library-message-warning" role="alert">
        {{ persistenceWarning }}
      </p>
      <p v-if="catalog.uncatalogedLibraryIds.length > 0" class="section-note">
        {{ catalog.uncatalogedLibraryIds.length }} früher gespeicherte Bibliotheken enthalten noch keine lokalen
        Fragen. Bitte importiere ihre Dateien einmal erneut; dein Fortschritt bleibt dabei erhalten.
      </p>

      <SectionOverview
        :sections="catalog.sections"
        :selected-section-id="activeSection?.sectionId ?? null"
        @open-section="openSection"
      />

      <section v-if="activeSection" class="start-card" aria-label="Lernabschnitt">
        <h2>{{ activeSection.label }}</h2>
        <p>
          {{ activeSection.libraries.length }}
          {{ activeSection.libraries.length === 1 ? 'Library' : 'Libraries' }} · {{ originalQuestions.length }} Fragen
        </p>
      </section>

      <section v-if="librarySummary" class="start-card" aria-label="Gespeicherter Fortschritt">
        <h2>Gespeicherter Fortschritt</h2>
        <p>
          Beantwortet: {{ librarySummary.answeredCount }} von {{ librarySummary.totalQuestions }}
          · zuletzt richtig: {{ librarySummary.lastCorrectCount }}
          · zuletzt falsch: {{ librarySummary.lastIncorrectCount }}
          · Versuche gesamt: {{ librarySummary.totalAttempts }}
        </p>
        <ul v-if="librarySummary.answeredCount > 0" class="progress-category-list">
          <li v-for="category in librarySummary.categories" :key="category.name">
            {{ category.name }}: {{ category.answered }}/{{ category.total }} beantwortet,
            {{ category.lastCorrect }} zuletzt richtig
          </li>
        </ul>
      </section>

      <section v-if="sessionPanel" class="start-card" aria-label="Lernrunde">
        <h2>{{ sessionPanel.title }}</h2>
        <p>{{ sessionPanel.text }}</p>

        <button
          v-if="sessionInfo.status === 'resumable'"
          class="start-button"
          type="button"
          @click="resumeLearningSession"
        >
          Lernrunde fortsetzen
        </button>
        <button class="secondary-button" type="button" @click="startLearningSession">
          {{ sessionPanel.discardLabel }}
        </button>
      </section>

      <section v-else-if="activeSection" class="start-card">
        <h2>Lernrunde bereit</h2>
        <p>Die Runde enthält alle Fragen dieses Lernabschnitts in gemischter Reihenfolge.</p>

        <button class="start-button" type="button" @click="startQuiz">Lernrunde starten</button>
      </section>

      <section v-else class="start-card">
        <h2>Quiz bereit</h2>
        <p>
          Du kannst mit den öffentlichen Beispiel-Fragen starten oder vorher eine
          private lokale JSON-Fragebank auswählen.
        </p>

        <button class="start-button" type="button" @click="startQuiz">
          Mit aktueller Fragebank starten
        </button>
      </section>
    </section>

    <section v-else-if="isQuizComplete" class="result-card">
      <p class="eyebrow">
        {{ isReviewMode ? 'Wiederholung abgeschlossen' : 'Quiz abgeschlossen' }}
      </p>
      <h2>Auswertung</h2>

      <div class="result-grid" aria-label="Ergebnisübersicht">
        <div>
          <span>Gesamtfragen</span>
          <strong>{{ totalQuestions }}</strong>
        </div>
        <div>
          <span>Richtige Antworten</span>
          <strong>{{ score }}</strong>
        </div>
        <div>
          <span>Falsche Antworten</span>
          <strong>{{ wrongAnswerCount }}</strong>
        </div>
        <div>
          <span>Prozentwert</span>
          <strong>{{ scorePercentage }}%</strong>
        </div>
        <div>
          <span>Beste Serie</span>
          <strong>{{ bestStreak }}</strong>
        </div>
      </div>

      <p class="result-message">{{ resultMessage }}</p>

      <section class="category-summary" aria-label="Kategorie-Auswertung">
        <h3>Kategorie-Auswertung</h3>
        <div class="category-list">
          <article
            v-for="category in categoryResults"
            :key="category.name"
            class="category-card"
            :class="category.statusClass"
          >
            <div>
              <h4>{{ category.name }}</h4>
              <p>{{ category.correct }}/{{ category.total }} richtig ({{ category.percentage }}%)</p>
            </div>
            <span>{{ category.label }}</span>
          </article>
        </div>
        <p class="learning-recommendation">{{ learningRecommendation }}</p>
      </section>
      <p v-if="incorrectlyAnsweredQuestions.length === 0" class="perfect-message">
        Perfekt – keine Fehler zum Wiederholen.
      </p>

      <div class="result-actions">
        <button
          v-if="incorrectlyAnsweredQuestions.length > 0"
          class="primary-button"
          type="button"
          @click="repeatIncorrectQuestions"
        >
          Falsche Fragen wiederholen
        </button>
        <button class="secondary-button" type="button" @click="restartWithCurrentQuestionBank">
          Neu starten
        </button>
        <button class="secondary-button" type="button" @click="showQuestionBankSelection">
          Andere Fragebank laden
        </button>
      </div>
    </section>

    <section v-else-if="currentQuestion" class="quiz-layout">
      <ScoreBox
        :current-question-index="currentQuestionIndex"
        :total-questions="totalQuestions"
        :score="score"
        :current-streak="currentStreak"
        :best-streak="bestStreak"
      />

      <QuizCard
        :question="currentQuestion"
        :selected-answer="selectedAnswer"
        :is-answered="isAnswered"
        :is-last-question="isLastQuestion"
        @select-answer="selectAnswer"
        @next-question="nextQuestion"
        @restart-quiz="finishQuiz"
      />
    </section>

    <section v-else class="question-card">
      <h2>Keine Fragen gefunden</h2>
      <p>Bitte prüfe die Datei src/data/public/sampleQuestions.json.</p>
    </section>

    <footer class="app-footer" aria-label="Projektinformationen">
      <span>Version 0.3.0</span>
      <span>Component refactor</span>
      <a
        href="https://github.com/s0582356/cybersecurity-concepts-quiz"
        target="_blank"
        rel="noreferrer"
      >
        GitHub
      </a>
    </footer>
  </main>
</template>
