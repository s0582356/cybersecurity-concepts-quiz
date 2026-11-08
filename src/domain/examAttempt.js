// Prüfungsversuch (Phase 3B): Datensatz, Validierung, Antworten, Navigation, Abgabe und Wertung. Rein, keine IO.
//
// Ein Versuch ist in sich geschlossen: Fragen, Optionen, Lösung, Erklärung und Merkhilfe stehen als
// Snapshot im Datensatz (`questionSnapshots`). Spätere Library-Updates, Revisionen oder Ersetzungen ändern
// einen Versuch nie. Der Versuch kennt keinen Lernprogress und keine Lernrunden-Felder (kein Streak,
// kein `isCorrect`, kein `sectionId`); er lebt ausschließlich im Object Store `examAttempts`.
//
// Alle Funktionen liefern neue Objekte und verändern ihre Eingabe nie.

import {
  LANGUAGE_MODE,
  MEMORY_AID_TYPES,
  OPTION_KEYS,
  normalizeLocalizedContent,
  planRoundQuestions,
  resolveQuestionContent,
  validateLocalizedContent,
} from './questionContent.js'
import { EXAM_ERROR, EXAM_MIN_QUESTIONS, EXAM_PRESETS, ExamError, resolveExamCount, selectExamQuestions } from './examSelection.js'
import { createSessionId, isValidOptionOrder, shuffled } from './session.js'

export const EXAM_SCHEMA_VERSION = 1
export const EXAM_SESSION_MODE = 'exam'
export const EXAM_TIMER_MODE_NONE = 'none'
export const EXAM_STATUS = { IN_PROGRESS: 'inProgress', SUBMITTED: 'submitted' }
export const EXAM_LANGUAGES = ['de', 'en']

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// V2-Schema: `memoryAid.type` ist ein geschlossenes Enum (DE wie EN). Ein Snapshot ohne Merkhilfe bleibt gültig; ist
// eine Merkhilfe vorhanden, muss ihr Typ bekannt sein (sonst gilt der Versuch als beschädigt, keine stille Ergänzung).
function memoryAidTypeSound(content) {
  const aid = content.memoryAid

  return aid === undefined || aid === null || (isPlainObject(aid) && MEMORY_AID_TYPES.includes(aid.type))
}

// Sprache -> languageMode im Datensatz (Deutsch: null, Englisch: "Nur Englisch"; `allAvailable` gibt es im Prüfungsmodus nicht).
function languageModeOf(language) {
  return language === 'en' ? LANGUAGE_MODE.ONLY_ENGLISH : null
}

// Pool-Eintrag: { question: <gespeicherte, normalisierte Frage>, libraryId, sectionId }.
// Snapshot: nur die Fassung der Versuchssprache, als eigene Kopie (keine Referenz auf Library-Objekte).
function snapshotOf(entry, language) {
  const { question } = entry
  const resolved = resolveQuestionContent(question, language)

  if (resolved.language !== language || resolved.fallback || !OPTION_KEYS.includes(question.correctOptionKey)) {
    throw new ExamError(EXAM_ERROR.CONTENT_UNAVAILABLE, question.id)
  }

  return {
    sectionId: entry.sectionId,
    category: question.category ?? null,
    difficulty: question.difficulty ?? null,
    correctOptionKey: question.correctOptionKey,
    content: normalizeLocalizedContent(resolved.content),
  }
}

// Erzeugt einen neuen, noch nicht gespeicherten Versuch. Die Zufallsentscheidungen (Fragenauswahl, Fragen- und
// Optionsreihenfolge) fallen hier genau einmal an.
// `pool`: Einträge { question, libraryId, sectionId }; `libraries`: Library-States (für den Versionsvermerk).
export function createExamAttempt({
  pool,
  libraries = [],
  language = 'de',
  preset = null,
  count = null,
  random = Math.random,
  now = Date.now(),
  examSessionId = createSessionId(),
}) {
  if (!EXAM_LANGUAGES.includes(language)) {
    throw new ExamError(EXAM_ERROR.INVALID_LANGUAGE, String(language))
  }

  const wanted = resolveExamCount({ preset, count })
  // Sprachlogik wiederverwenden: Englisch = nur Fragen mit gültigem EN ("Nur Englisch"), Deutsch = alle.
  const plan = planRoundQuestions(
    pool.map((entry) => entry.question),
    { language, mode: LANGUAGE_MODE.ONLY_ENGLISH },
  )
  const eligibleIds = new Set(plan.questions.map((question) => question.id))
  const eligible = pool.filter((entry) => eligibleIds.has(entry.question.id))

  // Presets werden auf die verfügbare Poolgröße (nach Sprachfilter) gekappt: N = min(preset, Pool), Spec 5.1.
  // Eine explizite Anzahl wird nie still verändert: sie scheitert, wenn sie den Pool übersteigt.
  const questionTotal = wanted.preset === 'custom' ? wanted.count : Math.min(wanted.count, eligible.length)

  if (eligible.length < EXAM_MIN_QUESTIONS || questionTotal > eligible.length) {
    throw new ExamError(EXAM_ERROR.POOL_TOO_SMALL, `${wanted.count} / ${eligible.length}`)
  }

  const selected = selectExamQuestions(
    eligible.map((entry) => ({ id: entry.question.id, sectionId: entry.sectionId, entry })),
    questionTotal,
    random,
  ).map(({ entry }) => entry)
  const orderedQuestionIds = selected.map((entry) => entry.question.id)
  const usedLibraryIds = new Set(selected.map((entry) => entry.libraryId))
  const attempt = {
    examSessionId,
    examSchemaVersion: EXAM_SCHEMA_VERSION,
    sessionMode: EXAM_SESSION_MODE,
    examPreset: wanted.preset,
    status: EXAM_STATUS.IN_PROGRESS,
    sessionStartedAt: now,
    lastActivityAt: now,
    completedAt: null,
    timerMode: EXAM_TIMER_MODE_NONE,
    sessionLanguage: language,
    languageMode: languageModeOf(language),
    poolSize: pool.length,
    skippedForLanguage: plan.skippedQuestionIds.length,
    questionCount: orderedQuestionIds.length,
    orderedQuestionIds,
    currentIndex: 0,
    currentQuestionId: orderedQuestionIds[0],
    // Optionsreihenfolge je Frage genau einmal, als Schlüsselpermutation (sprachunabhängig).
    optionOrder: Object.fromEntries(orderedQuestionIds.map((id) => [id, shuffled(OPTION_KEYS, random)])),
    answers: {},
    libraries: libraries
      .filter((state) => usedLibraryIds.has(state.libraryId))
      .map((state) => ({
        libraryId: state.libraryId,
        libraryVersion: state.libraryVersion,
        activeQuestionIndexHash: state.activeQuestionIndexHash,
      }))
      .sort((left, right) => left.libraryId.localeCompare(right.libraryId)),
    questionLibraries: Object.fromEntries(selected.map((entry) => [entry.question.id, entry.libraryId])),
    questionRevisions: Object.fromEntries(
      selected.map((entry) => [
        entry.question.id,
        entry.question.contentRevision ??
          libraries.find((state) => state.libraryId === entry.libraryId)?.questionRevisions?.[entry.question.id] ??
          null,
      ]),
    ),
    questionSnapshots: Object.fromEntries(selected.map((entry) => [entry.question.id, snapshotOf(entry, language)])),
    result: null,
  }
  const check = validateExamAttempt(attempt)

  if (!check.valid) {
    throw new ExamError(EXAM_ERROR.INVALID_ATTEMPT, check.problems.join(', '))
  }

  return attempt
}

function sameValue(left, right) {
  if (left === right) {
    return true
  }

  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) {
    return false
  }

  const keys = Object.keys(left)

  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]))
}

// Invarianten des Datensatzes. Eine Verletzung heißt "beschädigt": keine Reparatur, keine weitere Mutation.
export function validateExamAttempt(attempt) {
  const problems = []
  const check = (condition, problem) => {
    if (!condition) {
      problems.push(problem)
    }
  }

  if (!isPlainObject(attempt)) {
    return { valid: false, problems: ['notAnObject'] }
  }

  check(typeof attempt.examSessionId === 'string' && attempt.examSessionId !== '', 'examSessionId')
  check(attempt.examSchemaVersion === EXAM_SCHEMA_VERSION, 'examSchemaVersion')
  check(attempt.sessionMode === EXAM_SESSION_MODE, 'sessionMode')
  check(Object.values(EXAM_STATUS).includes(attempt.status), 'status')
  check(EXAM_LANGUAGES.includes(attempt.sessionLanguage), 'sessionLanguage')
  check(attempt.languageMode === languageModeOf(attempt.sessionLanguage), 'languageMode')
  check(Number.isFinite(attempt.sessionStartedAt) && Number.isFinite(attempt.lastActivityAt), 'timestamps')

  const ids = attempt.orderedQuestionIds

  check(Array.isArray(ids) && ids.length > 0, 'orderedQuestionIds')

  if (!Array.isArray(ids) || ids.length === 0) {
    return { valid: false, problems }
  }

  check(new Set(ids).size === ids.length, 'duplicateQuestionIds')
  check(attempt.questionCount === ids.length, 'questionCount')
  check(
    ids.every((id) => isPlainObject(attempt.questionSnapshots) && isPlainObject(attempt.questionSnapshots[id])),
    'questionSnapshots',
  )
  check(ids.every((id) => typeof attempt.questionLibraries?.[id] === 'string'), 'questionLibraries')
  check(ids.every((id) => Number.isInteger(attempt.questionRevisions?.[id])), 'questionRevisions')
  check(ids.every((id) => isValidOptionOrder(attempt.optionOrder?.[id])), 'optionOrder')
  check(
    ids.every((id) => {
      const snapshot = attempt.questionSnapshots?.[id]

      return (
        OPTION_KEYS.includes(snapshot?.correctOptionKey) &&
        typeof snapshot.sectionId === 'string' &&
        validateLocalizedContent(snapshot.content).valid &&
        memoryAidTypeSound(snapshot.content)
      )
    }),
    'snapshotContent',
  )
  check(
    isPlainObject(attempt.answers) &&
      Object.entries(attempt.answers).every(([id, key]) => ids.includes(id) && OPTION_KEYS.includes(key)),
    'answers',
  )
  check(Number.isInteger(attempt.currentIndex) && attempt.currentIndex >= 0 && attempt.currentIndex < ids.length, 'currentIndex')
  check(ids[attempt.currentIndex] === attempt.currentQuestionId, 'currentQuestionId')

  // Metadaten: geschlossene Werte statt "irgendetwas".
  const isCount = (value) => Number.isInteger(value) && value >= 0
  const presetKnown = attempt.examPreset === 'custom' || Object.hasOwn(EXAM_PRESETS, attempt.examPreset)
  const eligibleCount = attempt.poolSize - attempt.skippedForLanguage
  const poolKnown =
    isCount(attempt.poolSize) &&
    isCount(attempt.skippedForLanguage) &&
    eligibleCount >= ids.length &&
    (attempt.sessionLanguage === 'en' || attempt.skippedForLanguage === 0)

  check(attempt.timerMode === EXAM_TIMER_MODE_NONE, 'timerMode')
  check(presetKnown, 'examPreset')
  check(poolKnown, 'poolSize')
  // Ein Preset-Versuch hat genau min(Preset, verfügbarer Pool) Fragen (siehe createExamAttempt).
  check(
    !presetKnown || !poolKnown || attempt.examPreset === 'custom' || ids.length === Math.min(EXAM_PRESETS[attempt.examPreset], eligibleCount),
    'presetQuestionCount',
  )
  check(
    Array.isArray(attempt.libraries) &&
      attempt.libraries.every(
        (library) => isPlainObject(library) && ['libraryId', 'libraryVersion', 'activeQuestionIndexHash'].every((field) => typeof library[field] === 'string' && library[field] !== ''),
      ) &&
      ids.every((id) => attempt.libraries.some((library) => library.libraryId === attempt.questionLibraries?.[id])),
    'libraries',
  )

  const structurallySound = problems.length === 0
  const submitted = attempt.status === EXAM_STATUS.SUBMITTED

  check(submitted === (attempt.result !== null && attempt.result !== undefined), 'resultStatus')
  check(submitted === (attempt.completedAt !== null && attempt.completedAt !== undefined), 'completedAtStatus')

  if (submitted) {
    check(Number.isFinite(attempt.completedAt) && attempt.completedAt >= attempt.sessionStartedAt, 'completedAt')

    // Das Ergebnis wird nie neu geschrieben, aber es muss exakt zu Snapshot und Antworten passen (Counts, Summen,
    // Prozent, Abschnitte) und `finalizedAt` muss `completedAt` entsprechen.
    check(
      structurallySound &&
        isPlainObject(attempt.result) &&
        attempt.result.finalizedAt === attempt.completedAt &&
        sameValue(attempt.result, scoreExamAttempt(attempt, attempt.result.finalizedAt)),
      'result',
    )
  }

  return { valid: problems.length === 0, problems }
}

export function isExamActive(attempt) {
  return attempt?.status === EXAM_STATUS.IN_PROGRESS
}

// Zählung vor der Abgabe (noch ohne Wertung).
export function summarizeExamAttempt(attempt) {
  const answeredCount = attempt.orderedQuestionIds.filter((id) => id in attempt.answers).length

  return {
    questionCount: attempt.orderedQuestionIds.length,
    answeredCount,
    unansweredCount: attempt.orderedQuestionIds.length - answeredCount,
  }
}

// Gemeinsame Vorprüfung aller Mutationen: nur ein gültiger, laufender Versuch darf sich ändern.
function mutable(attempt) {
  if (!validateExamAttempt(attempt).valid) {
    return 'invalid'
  }

  return attempt.status === EXAM_STATUS.SUBMITTED ? 'submitted' : null
}

// Antwort setzen oder ersetzen. Die beantwortete Frage wird zur aktuellen Frage.
export function applyExamAnswer(attempt, { questionId, selectedOptionKey, now = Date.now() }) {
  const blocked = mutable(attempt)

  if (blocked) {
    return { applied: false, reason: blocked, attempt }
  }

  if (!attempt.orderedQuestionIds.includes(questionId)) {
    return { applied: false, reason: 'unknownQuestion', attempt }
  }

  if (!OPTION_KEYS.includes(selectedOptionKey)) {
    return { applied: false, reason: 'invalidOption', attempt }
  }

  return {
    applied: true,
    attempt: {
      ...attempt,
      answers: { ...attempt.answers, [questionId]: selectedOptionKey },
      currentIndex: attempt.orderedQuestionIds.indexOf(questionId),
      currentQuestionId: questionId,
      lastActivityAt: now,
    },
  }
}

// Navigation: Ziel per `index` oder `questionId`. Grenzen: 0 <= index < questionCount.
export function setExamPosition(attempt, { index = null, questionId = null, now = Date.now() }) {
  const blocked = mutable(attempt)

  if (blocked) {
    return { applied: false, reason: blocked, attempt }
  }

  const target = index ?? attempt.orderedQuestionIds.indexOf(questionId)

  if (questionId !== null && index === null && target === -1) {
    return { applied: false, reason: 'unknownQuestion', attempt }
  }

  if (!Number.isInteger(target) || target < 0 || target >= attempt.orderedQuestionIds.length) {
    return { applied: false, reason: 'outOfRange', attempt }
  }

  return {
    applied: true,
    attempt: {
      ...attempt,
      currentIndex: target,
      currentQuestionId: attempt.orderedQuestionIds[target],
      lastActivityAt: now,
    },
  }
}

export function moveExamPosition(attempt, direction, { now = Date.now() } = {}) {
  const delta = direction === 'next' ? 1 : direction === 'previous' ? -1 : null

  if (delta === null) {
    return { applied: false, reason: 'invalidDirection', attempt }
  }

  return setExamPosition(attempt, { index: attempt.currentIndex + delta, now })
}

// Wertung aus Snapshot + Antworten: richtig = gewählter Optionsschlüssel === correctOptionKey (nie über die
// Anzeigeposition). Unbeantwortet zählt weder als richtig noch als falsch. percent = correct / total (nicht /answered),
// auf ganze Prozent gerundet wie die bestehende Ergebnisansicht. Kein Bestanden-Urteil, keine skalierte Punktzahl.
export function scoreExamAttempt(attempt, finalizedAt) {
  const sections = new Map()
  const totals = { correct: 0, incorrect: 0, unanswered: 0 }

  attempt.orderedQuestionIds.forEach((id) => {
    const snapshot = attempt.questionSnapshots[id]
    const selected = attempt.answers[id]
    const outcome = selected === undefined ? 'unanswered' : selected === snapshot.correctOptionKey ? 'correct' : 'incorrect'
    const section = sections.get(snapshot.sectionId) ?? { sectionId: snapshot.sectionId, total: 0, correct: 0, incorrect: 0, unanswered: 0 }

    section.total++
    section[outcome]++
    totals[outcome]++
    sections.set(snapshot.sectionId, section)
  })

  const total = attempt.orderedQuestionIds.length

  return {
    total,
    ...totals,
    percent: Math.round((totals.correct / total) * 100),
    perSection: [...sections.values()].sort((left, right) => left.sectionId.localeCompare(right.sectionId, 'en', { numeric: true })),
    finalizedAt,
  }
}

// Abgabe. Idempotent: ein bereits abgegebener Versuch bleibt bitgleich, das Ergebnis wird nie neu berechnet.
export function finalizeExamAttemptRecord(attempt, now = Date.now()) {
  const blocked = mutable(attempt)

  if (blocked === null && !Number.isFinite(now)) {
    return { finalized: false, reason: 'invalidTime', attempt }
  }

  if (blocked === 'invalid') {
    return { finalized: false, reason: 'invalid', attempt }
  }

  if (blocked === 'submitted') {
    return { finalized: false, reason: 'alreadySubmitted', attempt }
  }

  // Läuft die Systemuhr zurück, bleibt die Abgabe gültig: completedAt wird nie vor den Start gesetzt.
  const completedAt = Math.max(now, attempt.sessionStartedAt)

  return {
    finalized: true,
    attempt: {
      ...attempt,
      status: EXAM_STATUS.SUBMITTED,
      completedAt,
      lastActivityAt: completedAt,
      result: scoreExamAttempt(attempt, completedAt),
    },
  }
}

// Darstellung einer Frage während der Prüfung. Enthält strukturell keine Lösung, Erklärung oder Merkhilfe:
// die Felder werden einzeln übernommen, nicht gefiltert.
export function presentExamQuestion(attempt, questionId) {
  const index = attempt.orderedQuestionIds.indexOf(questionId)

  if (index === -1) {
    return null
  }

  const { content } = attempt.questionSnapshots[questionId]

  return {
    id: questionId,
    index,
    total: attempt.orderedQuestionIds.length,
    text: content.question,
    options: attempt.optionOrder[questionId].map((key) => ({ key, text: content.optionText[key] })),
    selectedKey: attempt.answers[questionId] ?? null,
  }
}
