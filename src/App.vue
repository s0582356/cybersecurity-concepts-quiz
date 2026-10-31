<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import QuizCard from './components/QuizCard.vue'
import ScoreBox from './components/ScoreBox.vue'
import PrivateQuestionImporter from './components/PrivateQuestionImporter.vue'
import ImportReport from './components/ImportReport.vue'
import SectionOverview from './components/SectionOverview.vue'
import sampleQuestions from './data/public/sampleQuestions.json'
import { BATCH_STATUS, planLibraryBatch, summarizeBatch } from './domain/libraryCatalog.js'
import {
  SESSION_STATUS,
  isValidOptionOrder,
  optionOrderOf,
  shuffled,
} from './domain/session.js'
import {
  LANGUAGE_MODE,
  OPTION_KEYS,
  canPresentRound,
  isLocalizedQuestion,
  planRoundQuestions,
  presentQuestion,
  relocalizeQuestion,
} from './domain/questionContent.js'
import {
  UI_LOCALES,
  contentLocale,
  describeError,
  languageMode,
  loadLanguagePreference,
  msg,
  setContentLocale,
  setLanguage,
  setLanguageMode,
  t,
  uiLocale,
} from './i18n/index.js'
import { createSectionSessionRecord } from './domain/sectionSession.js'
import { DB_NAME, createProgressStore } from './storage/progressStore.js'
import { confirmPendingUpdate, importLibraryBatch } from './storage/catalogImport.js'
import { buildOverview, buildSectionView, readCatalogData, readSectionData } from './storage/sectionService.js'

const questions = ref(sampleQuestions)
// Name einer einzeln geladenen V1-Datei (sonst: öffentliche Beispiele bzw. der geöffnete Lernabschnitt).
const v1BankName = ref(null)
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
// Meldungen sind übersetzbare Deskriptoren, damit ein Sprachwechsel sie mit umstellt.
const importMessage = ref(null)
const persistenceWarning = ref(null)
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

// Phase 2F (Contract-Fix): Sprache und Fragenmenge gehören zur Runde, nicht zur globalen Präferenz.
// - Eine neue Runde nutzt die globale Präferenz (Inhaltssprache + Modus "Nur Englisch"/"Alle verfügbaren Fragen")
//   und speichert Sprache, Modus und ausgelassene IDs im Session-Datensatz.
// - Eine laufende/fortgesetzte Runde nutzt IMMER ihre gespeicherten Werte; die globale Präferenz ändert weder
//   ihre ID-Menge noch ihre Sprache (ein erlaubter Sprachwechsel in der Runde wird in der Session nachgetragen).
const roundLanguage = ref(null)
// Kontrollierte Rückfrage, wenn ein Sprachwechsel die laufende Runde nicht ohne Mengenänderung darstellen kann.
const languageSwitchNotice = ref(null)

const presentLanguage = computed(() => roundLanguage.value?.language ?? 'de')

const sectionCoverage = computed(() => activeSection.value?.coverage ?? null)

// Auswahl der Lernsprache im Lernabschnitt (nur die globale Präferenz für NEUE Runden).
const showLanguageChoice = computed(
  () => Boolean(activeSection.value) && ((sectionCoverage.value?.en ?? 0) > 0 || contentLocale.value === 'en'),
)

const languageChoice = computed(() => {
  if (contentLocale.value !== 'en') {
    return 'de'
  }

  return languageMode.value === LANGUAGE_MODE.ALL_AVAILABLE ? 'en-all' : 'en-only'
})

function chooseLanguageOption(option) {
  setContentLocale(option === 'de' ? 'de' : 'en')

  if (option !== 'de') {
    setLanguageMode(option === 'en-all' ? LANGUAGE_MODE.ALL_AVAILABLE : LANGUAGE_MODE.ONLY_ENGLISH)
  }
}

// Vorschau, welche Fragenmenge die nächste Runde hätte (nur Information).
const languagePreview = computed(() => {
  const coverage = sectionCoverage.value

  if (!coverage || contentLocale.value !== 'en') {
    return null
  }

  if (languageMode.value === LANGUAGE_MODE.ALL_AVAILABLE) {
    return coverage.en < coverage.total
      ? msg('language.preview.allAvailable', { missing: coverage.total - coverage.en })
      : null
  }

  if (coverage.en === 0) {
    return msg('language.noEnglish', { total: coverage.total })
  }

  return coverage.en < coverage.total
    ? msg('language.preview.onlyEnglish', { en: coverage.en, total: coverage.total, skipped: coverage.total - coverage.en })
    : null
})

// Hinweis zur laufenden Runde (Contract: ausgelassene Fragen müssen sichtbar sein).
const roundSkippedNotice = computed(() => {
  const round = roundLanguage.value

  return round?.language === 'en' && round.mode === LANGUAGE_MODE.ONLY_ENGLISH && round.skipped > 0
    ? msg('language.skipped', { skipped: round.skipped, total: round.total })
    : null
})

const contentNotice = computed(() => {
  if (isQuizStarted.value && roundSkippedNotice.value) {
    return roundSkippedNotice.value
  }

  if (!activeSection.value && contentLocale.value === 'en' && (v1BankName.value || isQuizStarted.value)) {
    return msg('language.contentNotice.bank')
  }

  return null
})

// Sprachangabe der gespeicherten Runde im Resume-Panel (und Hinweis, wenn die globale Auswahl abweicht).
const sessionLanguageInfo = computed(() => {
  const session = sessionInfo.value?.session

  if (!session || sessionInfo.value.status !== SESSION_STATUS.RESUMABLE) {
    return null
  }

  const language = session.sessionLanguage ?? 'de'
  const mode = language === 'en' ? session.languageMode : null
  const diverges = (contentLocale.value !== language) || (language === 'en' && languageMode.value !== mode)

  return {
    language,
    text:
      language === 'en'
        ? msg(mode === LANGUAGE_MODE.ALL_AVAILABLE ? 'session.language.enAll' : 'session.language.enOnly', {
            count: session.orderedQuestionIds.length,
          })
        : null,
    divergence: diverges ? msg('session.language.divergence') : null,
  }
})

const bankLabel = computed(() => {
  if (activeSection.value) {
    return t(activeSection.value.label)
  }

  return v1BankName.value ? t('app.bank.private', { name: v1BankName.value }) : t('app.bank.sample')
})

const categoryLabel = (name) => (name === 'Allgemein' ? t('category.general') : name)
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
    return t('result.msg.ready')
  }

  if (scorePercentage.value >= 75) {
    return t('result.msg.near')
  }

  if (scorePercentage.value >= 60) {
    return t('result.msg.solid')
  }

  return t('result.msg.unsure')
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
      let label = t('result.category.review')
      let statusClass = 'category-review'

      if (percentage >= 80) {
        label = t('result.category.strong')
        statusClass = 'category-strong'
      } else if (percentage >= 60) {
        label = t('result.category.solid')
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
    return t('result.recommendation.weak', { names: weakCategories.value.map(categoryLabel).join(', ') })
  }

  return t('result.recommendation.none')
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

// Lokalisierte V2-Fragen werden über ihre Optionsschlüssel gemischt (Reihenfolge bleibt beim Sprachwechsel erhalten);
// V1-/Beispielfragen haben keine Sprachfassungen und werden wie bisher über die Texte gemischt.
function presentShuffled(question, language = presentLanguage.value) {
  if (!isLocalizedQuestion(question)) {
    return { ...question, options: shuffleOptions(question.options) }
  }

  return presentQuestion(question, language, { optionOrder: shuffled(OPTION_KEYS) })
}

function shuffleOptionsForQuestions(questionList, language) {
  return questionList.map((question) => presentShuffled(question, language))
}

// Sprachwechsel (nur Darstellung): gleiche Fragen, gleiche Positionen, gleiche Optionsschlüssel und Auswahl.
function relocalizeAll(locale) {
  const shown = questions.value[currentQuestionIndex.value]
  const selectedKey = shown && selectedAnswer.value !== null ? optionKeyOf(shown, selectedAnswer.value) : null

  questions.value = questions.value.map((question) => relocalizeQuestion(question, locale))
  incorrectlyAnsweredQuestions.value = incorrectlyAnsweredQuestions.value.map((question) =>
    relocalizeQuestion(question, locale),
  )

  if (selectedKey) {
    selectedAnswer.value = questions.value[currentQuestionIndex.value]?.optionTextByKey?.[selectedKey] ?? selectedAnswer.value
  }
}

// Sprachwechsel über den Schalter: Oberfläche und Inhaltspräferenz folgen immer; die laufende Runde wechselt
// nur, wenn ihre feste Fragenmenge in der Zielsprache darstellbar ist. Sonst bleibt sie unverändert und der
// Nutzer entscheidet kontrolliert (neue Runde oder weiter in der bisherigen Sprache).
function switchLanguage(code) {
  setLanguage(code)
  languageSwitchNotice.value = null

  const round = roundLanguage.value

  if (!isQuizStarted.value || !round || round.language === code) {
    return
  }

  const check = canPresentRound(questions.value, { language: code, mode: round.mode })

  if (!check.possible) {
    languageSwitchNotice.value = { missing: check.missing, total: questions.value.length, target: code }
    return
  }

  roundLanguage.value = { ...round, language: code }
  relocalizeAll(code)

  if (activeSessionId.value && !isReviewMode.value) {
    const sessionId = activeSessionId.value

    queueWrite(() => progressStore.setSessionLanguage(sessionId, code), 'warn.sessionNotSaved')
  }
}

function keepRoundLanguage() {
  // Bewusste Entscheidung: die laufende Runde bleibt in ihrer Sprache, auch die Inhaltspräferenz folgt ihr.
  languageSwitchNotice.value = null
  setContentLocale(presentLanguage.value)
}

function startNewRoundInSwitchedLanguage() {
  languageSwitchNotice.value = null
  return startLearningSession()
}

// Barrierefreiheit: die Dokumentsprache folgt der Oberflächensprache.
watch(uiLocale, (locale) => document.documentElement.setAttribute('lang', locale), { immediate: true })

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
  // Fragenmenge und Sprache der neuen Runde nach Contract: Deutsch = alle; Englisch = "Nur Englisch" (gültiges EN)
  // bzw. "Alle verfügbaren Fragen" (fehlendes EN sichtbar als deutscher Fallback).
  const plan = planRoundQuestions(originalQuestions.value, { language: contentLocale.value, mode: languageMode.value })

  if (plan.questions.length === 0) {
    importMessage.value = { type: 'error', message: msg('language.noEnglish', { total: originalQuestions.value.length }) }
    return
  }

  importMessage.value = null
  languageSwitchNotice.value = null

  const orderedQuestions = shuffled(shuffleOptionsForQuestions(plan.questions, plan.language))
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
        sessionLanguage: plan.language,
        languageMode: plan.mode,
        skippedQuestionIds: plan.skippedQuestionIds,
      })

      await progressStore.startNewSession(session)
      activeSessionId.value = session.sessionId
    } catch (error) {
      persistenceWarning.value = msg('warn.sessionNotStored', { detail: describeError(error) })
    }
  }

  roundLanguage.value = {
    language: plan.language,
    mode: plan.mode,
    skipped: plan.skippedQuestionIds.length,
    total: originalQuestions.value.length,
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
  // Sprache und Modus kommen aus der gespeicherten Runde (nicht aus der globalen Präferenz); ältere Runden: Deutsch.
  const language = session.sessionLanguage ?? 'de'
  const resumedQuestions = info.orderedQuestions.map((question) => {
    if (question.id === info.currentQuestionId && isValidOptionOrder(restoredOrder)) {
      return presentQuestion(question, language, { optionOrder: restoredOrder })
    }

    return presentShuffled(question, language)
  })
  const questionsById = new Map(resumedQuestions.map((question) => [question.id, question]))
  const correctIds = new Set(session.correctQuestionIds)

  roundLanguage.value = {
    language,
    mode: session.languageMode ?? null,
    skipped: session.skippedQuestionIds?.length ?? 0,
    total: session.orderedQuestionIds.length + (session.skippedQuestionIds?.length ?? 0),
  }
  languageSwitchNotice.value = null
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
  queueWrite(() => progressStore.markSessionResumed(sessionId), 'warn.sessionNotUpdated')
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
      'warn.sessionNotSaved',
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
      'warn.sessionNotCompleted',
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
  roundLanguage.value = null
  languageSwitchNotice.value = null
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
        storageError = describeError(error)
        persistenceWarning.value = msg('warn.progressNotStored', { detail: describeError(error) })
        return false
      })
  }

  return storageReady
}

// Schreibaufträge laufen nacheinander (Antwort → Weiter → Abschluss behalten ihre Reihenfolge).
function queueWrite(task, failureKey) {
  pendingWrites = pendingWrites
    .then(async () => {
      if (await storageReady) {
        await task()
      }
    })
    .catch((error) => {
      persistenceWarning.value = msg(failureKey, { detail: describeError(error) })
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
  }, 'warn.progressNotSaved')
}

const sessionPanel = computed(() => {
  const info = sessionInfo.value

  if (!info || info.status === SESSION_STATUS.NONE) {
    return null
  }

  if (info.status === SESSION_STATUS.COMPLETED) {
    return {
      title: t('session.completed.title'),
      text: t('session.completed.text', {
        correct: info.stats.correctCount,
        incorrect: info.stats.incorrectCount,
        total: info.stats.totalCount,
      }),
      discardLabel: t('session.completed.discard'),
    }
  }

  if (info.status === SESSION_STATUS.RESUMABLE) {
    const { stats } = info

    return {
      title: t('session.running.title'),
      text: t('session.running.text', {
        current: info.currentIndex + 1,
        total: stats.totalCount,
        answered: stats.answeredCount,
        correct: stats.correctCount,
        incorrect: stats.incorrectCount,
        remaining: stats.remainingCount,
        extra: info.newQuestionCount > 0 ? t('session.running.newQuestions', { count: info.newQuestionCount }) : '',
      }),
      discardLabel: t('session.running.discard'),
    }
  }

  const reasons = {
    questionsChanged: t('session.reason.questionsChanged', { missing: info.missingQuestionIds?.length ?? 0 }),
    revisionsChanged: t('session.reason.revisionsChanged', { count: info.revisedQuestionIds?.length ?? 0 }),
    currentQuestionMissing: t('session.reason.currentQuestionMissing'),
    invalidSession: t('session.reason.invalidSession'),
  }

  return {
    title: t('session.blocked.title'),
    text: t('session.blocked.text', { reason: reasons[info.reason] }),
    discardLabel: t('session.blocked.discard'),
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
    persistenceWarning.value = msg('warn.libraryNotRead', { detail: describeError(error) })
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
    persistenceWarning.value = msg('warn.sectionNotRead', { detail: describeError(error) })
    return false
  }

  const view = buildSectionView(data)

  if (view.error) {
    activeSection.value = null
    librarySummary.value = null
    sessionInfo.value = null
    importMessage.value = { type: 'error', message: msg('section.error', { label: view.label, message: view.error }) }
    return false
  }

  activeSection.value = {
    sectionId,
    label: view.label,
    libraries: view.libraries,
    ephemeral: memoryEntries.size > 0,
  }
  activeSection.value.coverage = view.coverage
  originalQuestions.value = view.questions
  v1BankName.value = null
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

  roundLanguage.value = null
  languageSwitchNotice.value = null
  questions.value = shuffleOptionsForQuestions(originalQuestions.value, 'de')
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
  roundLanguage.value = null
  languageSwitchNotice.value = null
  activeSection.value = null
  activeSessionId.value = null
  librarySummary.value = null
  sessionInfo.value = null
  originalQuestions.value = importedQuestions
  questions.value = shuffleOptionsForQuestions(importedQuestions)
  v1BankName.value = fileName
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
      message: msg('result.memoryOnly'),
    })
  })

  importReport.value = {
    results: results.sort((a, b) => a.fileName.localeCompare(b.fileName)),
    summary: summarizeBatch(entries, plan.importable),
    pendingLibraryIds: [],
  }
  persistenceWarning.value = msg('warn.progressNotStored', { detail: storageError || msg('warn.storageUnavailable') })
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
    persistenceWarning.value = msg('warn.progressNotStored', { detail: describeError(error) })
    return
  }

  await refreshCatalog()
  await refreshSection()
}

async function handleFilesLoaded(entries) {
  importMessage.value = null
  persistenceWarning.value = null
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
    setResult({ status: BATCH_STATUS.REJECTED, message: msg('result.confirmFailed', { detail: describeError(error) }) })
    return
  }

  setResult({
    status: BATCH_STATUS.VERSION_UPDATED,
    message: msg('result.confirmDone', { version: entry.library.libraryVersion }),
  })
  await refreshCatalog()
  await openSection(entry.library.learningSectionId)
}

loadLanguagePreference()

onMounted(initializeCatalog)
onBeforeUnmount(() => progressStore.close())
</script>

<template>
  <main class="app-shell">
    <section class="hero-section">
      <div class="language-switch" role="group" :aria-label="t('language.switch')">
        <button
          v-for="code in UI_LOCALES"
          :key="code"
          class="language-button"
          :class="{ 'language-button-active': uiLocale === code }"
          type="button"
          :aria-pressed="uiLocale === code"
          :title="t(`language.${code}`)"
          @click="switchLanguage(code)"
        >
          {{ code.toUpperCase() }}
        </button>
      </div>
      <p class="eyebrow">{{ t('app.eyebrow') }}</p>
      <h1>{{ t('app.title') }}</h1>
      <p class="intro">{{ t('app.intro') }}</p>
      <p class="question-bank-label">{{ bankLabel }}</p>
      <p v-if="isReviewMode" class="review-mode-label">{{ t('app.reviewMode') }}</p>
      <p v-if="contentNotice" class="language-note" role="status">{{ t(contentNotice) }}</p>
      <div v-if="languageSwitchNotice" class="language-note language-switch-notice" role="alert">
        <p>{{ t('language.switchBlocked', languageSwitchNotice) }}</p>
        <button class="primary-button" type="button" @click="startNewRoundInSwitchedLanguage">
          {{ t('language.switchBlocked.newRound') }}
        </button>
        <button class="secondary-button" type="button" @click="keepRoundLanguage">
          {{ t('language.switchBlocked.keep') }}
        </button>
      </div>
    </section>

    <section v-if="!isQuizStarted" class="start-layout" :aria-label="t('app.prepare')">
      <PrivateQuestionImporter :empty="!hasCatalog" @files-loaded="handleFilesLoaded" />

      <p
        v-if="importMessage"
        class="library-message"
        :class="`library-message-${importMessage.type}`"
        role="status"
      >
        {{ t(importMessage.message) }}
      </p>
      <ImportReport v-if="importReport" :report="importReport" @confirm-update="confirmLibraryUpdate" />
      <p v-if="persistenceWarning" class="library-message library-message-warning" role="alert">
        {{ t(persistenceWarning) }}
      </p>
      <p v-if="catalog.uncatalogedLibraryIds.length > 0" class="section-note">
        {{ t('section.uncataloged', { count: catalog.uncatalogedLibraryIds.length }) }}
      </p>

      <SectionOverview
        :sections="catalog.sections"
        :selected-section-id="activeSection?.sectionId ?? null"
        @open-section="openSection"
      />

      <section v-if="activeSection" class="start-card" :aria-label="t('section.detail')">
        <h2>{{ t(activeSection.label) }}</h2>
        <p>
          {{ t('section.libraries', { count: activeSection.libraries.length }) }} ·
          {{ t('section.questions', { count: originalQuestions.length }) }}
        </p>
      </section>

      <section v-if="showLanguageChoice" class="start-card language-choice" :aria-label="t('language.choice.label')">
        <h2>{{ t('language.choice.title') }}</h2>
        <div class="language-options" role="group" :aria-label="t('language.choice.label')">
          <button
            v-for="option in ['de', 'en-only', 'en-all']"
            :key="option"
            class="language-option"
            :class="{ 'language-option-active': languageChoice === option }"
            type="button"
            :data-option="option"
            :aria-pressed="languageChoice === option"
            @click="chooseLanguageOption(option)"
          >
            {{ t(`language.choice.${option}`, { en: sectionCoverage?.en ?? 0, total: sectionCoverage?.total ?? 0 }) }}
          </button>
        </div>
        <p v-if="languagePreview" class="language-preview">{{ t(languagePreview) }}</p>
      </section>

      <section v-if="librarySummary" class="start-card" :aria-label="t('progress.title')">
        <h2>{{ t('progress.title') }}</h2>
        <p>
          {{
            t('progress.summary', {
              answered: librarySummary.answeredCount,
              total: librarySummary.totalQuestions,
              correct: librarySummary.lastCorrectCount,
              incorrect: librarySummary.lastIncorrectCount,
              attempts: librarySummary.totalAttempts,
            })
          }}
        </p>
        <ul v-if="librarySummary.answeredCount > 0" class="progress-category-list">
          <li v-for="category in librarySummary.categories" :key="category.name">
            {{
              t('progress.category', {
                name: categoryLabel(category.name),
                answered: category.answered,
                total: category.total,
                correct: category.lastCorrect,
              })
            }}
          </li>
        </ul>
      </section>

      <section v-if="sessionPanel" class="start-card" :aria-label="t('session.label')">
        <h2>{{ sessionPanel.title }}</h2>
        <p>{{ sessionPanel.text }}</p>
        <p v-if="sessionLanguageInfo?.text" class="session-language">{{ t(sessionLanguageInfo.text) }}</p>
        <p v-if="sessionLanguageInfo?.divergence" class="session-language">{{ t(sessionLanguageInfo.divergence) }}</p>

        <button
          v-if="sessionInfo.status === 'resumable'"
          class="start-button"
          type="button"
          @click="resumeLearningSession"
        >
          {{ t('session.resume') }}
        </button>
        <button class="secondary-button" type="button" @click="startLearningSession">
          {{ sessionPanel.discardLabel }}
        </button>
      </section>

      <section v-else-if="activeSection" class="start-card">
        <h2>{{ t('section.ready.title') }}</h2>
        <p>{{ t('section.ready.text') }}</p>

        <button class="start-button" type="button" @click="startQuiz">{{ t('section.ready.start') }}</button>
      </section>

      <section v-else class="start-card">
        <h2>{{ t('quiz.ready.title') }}</h2>
        <p>{{ t('quiz.ready.text') }}</p>

        <button class="start-button" type="button" @click="startQuiz">
          {{ t('quiz.ready.start') }}
        </button>
      </section>
    </section>

    <section v-else-if="isQuizComplete" class="result-card">
      <p class="eyebrow">
        {{ isReviewMode ? t('result.eyebrow.review') : t('result.eyebrow.done') }}
      </p>
      <h2>{{ t('result.title') }}</h2>

      <div class="result-grid" :aria-label="t('result.grid.label')">
        <div>
          <span>{{ t('result.total') }}</span>
          <strong>{{ totalQuestions }}</strong>
        </div>
        <div>
          <span>{{ t('result.correct') }}</span>
          <strong>{{ score }}</strong>
        </div>
        <div>
          <span>{{ t('result.wrong') }}</span>
          <strong>{{ wrongAnswerCount }}</strong>
        </div>
        <div>
          <span>{{ t('result.percent') }}</span>
          <strong>{{ scorePercentage }}%</strong>
        </div>
        <div>
          <span>{{ t('result.bestStreak') }}</span>
          <strong>{{ bestStreak }}</strong>
        </div>
      </div>

      <p class="result-message">{{ resultMessage }}</p>
      <p v-if="roundSkippedNotice" class="language-note" role="status">{{ t(roundSkippedNotice) }}</p>

      <section class="category-summary" :aria-label="t('result.categories.label')">
        <h3>{{ t('result.categories.title') }}</h3>
        <div class="category-list">
          <article
            v-for="category in categoryResults"
            :key="category.name"
            class="category-card"
            :class="category.statusClass"
          >
            <div>
              <h4>{{ categoryLabel(category.name) }}</h4>
              <p>
                {{
                  t('result.categories.line', {
                    correct: category.correct,
                    total: category.total,
                    percent: category.percentage,
                  })
                }}
              </p>
            </div>
            <span>{{ category.label }}</span>
          </article>
        </div>
        <p class="learning-recommendation">{{ learningRecommendation }}</p>
      </section>
      <p v-if="incorrectlyAnsweredQuestions.length === 0" class="perfect-message">
        {{ t('result.perfect') }}
      </p>

      <div class="result-actions">
        <button
          v-if="incorrectlyAnsweredQuestions.length > 0"
          class="primary-button"
          type="button"
          @click="repeatIncorrectQuestions"
        >
          {{ t('result.repeatWrong') }}
        </button>
        <button class="secondary-button" type="button" @click="restartWithCurrentQuestionBank">
          {{ t('result.restart') }}
        </button>
        <button class="secondary-button" type="button" @click="showQuestionBankSelection">
          {{ t('result.otherBank') }}
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
      <h2>{{ t('quiz.noQuestions.title') }}</h2>
      <p>{{ t('quiz.noQuestions.text') }}</p>
    </section>

    <footer class="app-footer" :aria-label="t('app.footer.label')">
      <span>{{ t('app.footer.version') }}</span>
      <span>{{ t('app.footer.refactor') }}</span>
      <a
        href="https://github.com/s0582356/cybersecurity-concepts-quiz"
        target="_blank"
        rel="noreferrer"
      >
        {{ t('app.footer.github') }}
      </a>
    </footer>
  </main>
</template>
