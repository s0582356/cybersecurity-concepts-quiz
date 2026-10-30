<script setup>
import { computed, onBeforeUnmount, ref } from 'vue'
import QuizCard from './components/QuizCard.vue'
import ScoreBox from './components/ScoreBox.vue'
import PrivateQuestionImporter from './components/PrivateQuestionImporter.vue'
import sampleQuestions from './data/public/sampleQuestions.json'
import { summarizeLibraryProgress } from './domain/progressSummary.js'
import {
  SESSION_STATUS,
  applyOptionOrder,
  createSessionRecord,
  evaluateSession,
  isValidOptionOrder,
  optionOrderOf,
  shuffled,
} from './domain/session.js'
import { createProgressStore } from './storage/progressStore.js'
import {
  CHANGE_KIND,
  IMPORT_STATUS,
  applyLibraryUpdate,
  registerLibraryImport,
} from './storage/libraryImport.js'

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
const activeLibrary = ref(null)
const importMessage = ref(null)
const persistenceWarning = ref('')
const librarySummary = ref(null)
// Phase 2B: Resume-Zustand der V2-Lernrunde (getrennt vom dauerhaften Question Progress).
const sessionInfo = ref(null)
// Phase 2C: erkanntes Library-Update, das noch nicht geladen wurde (wartet auf Entscheidung/bleibt blockiert).
const pendingUpdate = ref(null)
// Phase 2D: Ersetzungs-Index (nur IDs und Policies; wird lokal geladen, nie im Repo mitgeliefert).
const retiredIndex = ref(null)
const activeSessionId = ref(null)
let storageReady = null
let pendingWrites = Promise.resolve()

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
  if (activeLibrary.value) {
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

  if (await storageReady) {
    try {
      const session = createSessionRecord({
        library: activeLibrary.value,
        orderedQuestionIds: orderedQuestions.map((question) => question.id),
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
  if (activeLibrary.value) {
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
  refreshLibrarySummary()
  refreshSessionInfo()
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
  if (!question.libraryId || !activeLibrary.value) {
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

async function refreshSessionInfo() {
  sessionInfo.value = null

  if (!activeLibrary.value) {
    return
  }

  await pendingWrites

  if (!(await storageReady)) {
    return
  }

  try {
    const session = await progressStore.getLatestSession(activeLibrary.value.libraryId)

    sessionInfo.value = evaluateSession(session, activeLibrary.value, originalQuestions.value)
  } catch (error) {
    persistenceWarning.value = `Lernrunde konnte nicht gelesen werden: ${error.message}`
  }
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

    return {
      title: 'Lernrunde läuft',
      text:
        `Frage ${info.currentIndex + 1} von ${stats.totalCount} · ${stats.answeredCount} beantwortet · ` +
        `${stats.correctCount} richtig · ${stats.incorrectCount} falsch · ${stats.remainingCount} offen`,
      discardLabel: 'Aktuelle Runde verwerfen und neu starten',
    }
  }

  const reasons = {
    hashChanged: 'Die Datei hat einen anderen Fragenstand als zu Beginn der Runde.',
    questionsChanged: `Die Fragen dieser Datei passen nicht zur gespeicherten Runde (${info.missingQuestionIds?.length ?? 0} fehlen, ${info.extraQuestionIds?.length ?? 0} neu).`,
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

async function refreshLibrarySummary() {
  librarySummary.value = null

  if (!activeLibrary.value) {
    return
  }

  await pendingWrites

  if (!(await storageReady)) {
    return
  }

  try {
    const records = await progressStore.listProgressForLibrary(activeLibrary.value.libraryId)
    librarySummary.value = summarizeLibraryProgress(originalQuestions.value, records)
  } catch (error) {
    persistenceWarning.value = `Fortschritt konnte nicht gelesen werden: ${error.message}`
  }
}

const importMessages = {
  [IMPORT_STATUS.NEW]: 'Neue Bibliothek erkannt. Dein Fortschritt wird ab jetzt lokal im Browser gespeichert.',
  [IMPORT_STATUS.KNOWN]: 'Bekannte Bibliothek erkannt. Gespeicherter Fortschritt wird verwendet.',
  [IMPORT_STATUS.VERSION_UPDATED]:
    'Bekannte Bibliothek in neuerer Version erkannt. Gespeicherter Fortschritt bleibt erhalten.',
}

const UPDATE_INTRO =
  'Diese Bibliothek wurde aktualisiert. Dein bisheriger Lernfortschritt bleibt gespeichert, ' +
  'aber die aktuelle Lernrunde kann erst nach einer Fortschrittsmigration fortgesetzt werden.'

function describeUpdate({ changeKind, change, replacements, unexplained }) {
  const count = (list) => list?.length ?? 0

  if (changeKind === CHANGE_KIND.QUESTIONS_REPLACED) {
    const inherited = replacements.filter((replacement) => replacement.policy === 'inherit').length
    const reset = replacements.length - inherited

    return {
      compatible: true,
      text:
        `${UPDATE_INTRO} ${replacements.length} Fragen wurden ersetzt: ${inherited} übernehmen den bisherigen Fortschritt ` +
        `(gleiches Lernziel), ${reset} starten ohne Fortschritt (neues Lernziel). ` +
        'Eine laufende Lernrunde wird nur angepasst, wenn das sicher möglich ist. ' +
        'Du kannst die Aktualisierung bewusst übernehmen. Die Datei wurde noch nicht geladen.',
    }
  }

  if (changeKind === CHANGE_KIND.QUESTIONS_REMOVED) {
    return {
      compatible: false,
      text:
        `${UPDATE_INTRO} ${count(change.removed)} Fragen wurden entfernt, ${count(unexplained)} davon sind durch ` +
        'den Ersetzungs-Index nicht erklärt (Index fehlt oder die Ziel-Bibliothek ist nicht geladen). ' +
        'Lade die Ersetzungsliste (retired-index.json) bzw. die Ziel-Bibliothek und importiere die Datei erneut. ' +
        'Die Datei wurde nicht geladen; Fortschritt und Lernrunde bleiben unverändert gespeichert.',
    }
  }

  if (changeKind === CHANGE_KIND.REVISIONS_ONLY) {
    return {
      compatible: true,
      text:
        `${UPDATE_INTRO} ${count(change.revised)} Fragen wurden überarbeitet; dein Fortschritt dazu bleibt erhalten. ` +
        'Du kannst die Aktualisierung bewusst übernehmen. Die Datei wurde noch nicht geladen.',
    }
  }

  if (changeKind === CHANGE_KIND.QUESTIONS_ADDED) {
    return {
      compatible: true,
      text:
        `${UPDATE_INTRO} ${count(change.added)} Fragen sind neu (sie starten ohne Fortschritt)` +
        (count(change.revised) > 0 ? `, ${count(change.revised)} wurden überarbeitet` : '') +
        '. Eine laufende Lernrunde kann danach nicht fortgesetzt, nur neu gestartet werden. ' +
        'Die Datei wurde noch nicht geladen.',
    }
  }

  return {
    compatible: false,
    text:
      `${UPDATE_INTRO} Diese Änderung kann in dieser App-Version noch nicht übernommen werden ` +
      '(z. B. entfernte Fragen oder eine abweichende Datei). Die Datei wurde nicht geladen; ' +
      'Fortschritt und Lernrunde bleiben unverändert gespeichert.',
  }
}

// Gibt false zurück, wenn der Import kontrolliert gestoppt wird.
async function registerV2Library(library) {
  if (!(await ensureStorage())) {
    return true
  }

  try {
    const result = await registerLibraryImport(progressStore, library, { retiredIndex: retiredIndex.value })

    if (result.status === IMPORT_STATUS.UPDATE_REQUIRES_MIGRATION) {
      const description = describeUpdate(result)

      importMessage.value = { type: 'error', text: description.text }
      pendingUpdate.value = description.compatible ? { library, ...description } : null
      return false
    }

    importMessage.value = { type: 'info', text: importMessages[result.status] }
    return true
  } catch (error) {
    persistenceWarning.value = `Fortschritt wird nicht gespeichert: ${error.message}`
    return true
  }
}

async function loadPrivateQuestions({ questions: importedQuestions, fileName, library = null }) {
  importMessage.value = null
  persistenceWarning.value = ''
  pendingUpdate.value = null
  sessionInfo.value = null
  activeSessionId.value = null

  if (library) {
    if (!(await registerV2Library(library))) {
      // Kontrolliert gestoppt: Datei merken, falls das Update bewusst übernommen werden darf.
      if (pendingUpdate.value) {
        pendingUpdate.value = { ...pendingUpdate.value, questions: importedQuestions, fileName }
      }

      return
    }

    activeLibrary.value = library
  } else {
    activeLibrary.value = null
    librarySummary.value = null
  }

  await showLoadedBank(importedQuestions, fileName)
}

async function showLoadedBank(importedQuestions, fileName) {
  originalQuestions.value = importedQuestions
  questions.value = shuffleOptionsForQuestions(importedQuestions)
  questionBankName.value = `Private Fragebank: ${fileName}`
  isReviewMode.value = false
  isQuizStarted.value = false
  resetQuizProgress()
  await refreshLibrarySummary()
  await refreshSessionInfo()
}

// Bewusste Entscheidung des Nutzers: kompatible Änderung übernehmen (Fortschritt bleibt, nichts wird kopiert).
async function confirmLibraryUpdate() {
  const pending = pendingUpdate.value

  if (!pending) {
    return
  }

  try {
    await pendingWrites
    await applyLibraryUpdate(progressStore, pending.library, { retiredIndex: retiredIndex.value })
  } catch (error) {
    importMessage.value = { type: 'error', text: `Aktualisierung nicht möglich: ${error.message}` }
    pendingUpdate.value = null
    return
  }

  pendingUpdate.value = null
  importMessage.value = {
    type: 'info',
    text: `Bibliothek auf Version ${pending.library.libraryVersion} aktualisiert. Dein Fortschritt bleibt erhalten.`,
  }
  activeLibrary.value = pending.library
  await showLoadedBank(pending.questions, pending.fileName)
}

async function loadRetiredIndex({ entries, fileName }) {
  importMessage.value = null
  persistenceWarning.value = ''

  if (!(await ensureStorage())) {
    return
  }

  try {
    await progressStore.saveRetiredIndex(entries)
    retiredIndex.value = entries
    importMessage.value = {
      type: 'info',
      text: `Ersetzungsliste ${fileName} geladen (${Object.keys(entries).length} Einträge). Sie wird bei Bibliotheks-Updates verwendet.`,
    }
  } catch (error) {
    persistenceWarning.value = `Ersetzungsliste konnte nicht gespeichert werden: ${error.message}`
  }
}

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
      <PrivateQuestionImporter
        @questions-loaded="loadPrivateQuestions"
        @retired-index-loaded="loadRetiredIndex"
      />

      <p
        v-if="importMessage"
        class="library-message"
        :class="`library-message-${importMessage.type}`"
        role="status"
      >
        {{ importMessage.text }}
      </p>
      <section v-if="pendingUpdate" class="start-card" aria-label="Bibliotheks-Update">
        <h2>Aktualisierung verfügbar</h2>
        <button class="start-button" type="button" @click="confirmLibraryUpdate">
          Aktualisierung übernehmen
        </button>
      </section>
      <p v-if="persistenceWarning" class="library-message library-message-warning" role="alert">
        {{ persistenceWarning }}
      </p>

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
