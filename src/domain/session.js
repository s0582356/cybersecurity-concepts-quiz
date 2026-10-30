// Session-/Resume-Zustand einer V2-Lernrunde (Phase 2B).
//
// Strikt getrennt vom dauerhaften Question Progress (Phase 2A):
// - Question Progress: Lebenszeit-Zähler je (libraryId, questionId), runden-übergreifend.
// - Session: genau eine Lernrunde mit fester Fragenreihenfolge, Position, Rundenstand.
//
// Alle Funktionen hier sind rein (keine IO) und werden vom Store innerhalb
// einer Transaktion bzw. von der App zur Auswertung gespeicherter Sessions genutzt.

export const SESSION_MODE_LEARNING = 'learning'
export const SESSION_STATUS = {
  NONE: 'none',
  RESUMABLE: 'resumable',
  COMPLETED: 'completed',
  RESUME_REQUIRES_MIGRATION: 'resumeRequiresMigration',
}

const OPTION_KEYS = ['a', 'b', 'c', 'd']

export function shuffled(items, random = Math.random) {
  const copy = [...items]

  for (let index = copy.length - 1; index > 0; index--) {
    const randomIndex = Math.floor(random() * (index + 1))
    ;[copy[index], copy[randomIndex]] = [copy[randomIndex], copy[index]]
  }

  return copy
}

export function createSessionId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID()
  }

  return `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

// Optionsreihenfolge als Keys (a–d) der angezeigten Optionen. Fragenspezifischer UI-State:
// er gehört immer zu genau einer Question-ID und wird nie auf eine andere übertragen.
export function optionOrderOf(question) {
  const textByKey = question.optionTextByKey

  if (!textByKey) {
    return null
  }

  const order = question.options.map((text) => OPTION_KEYS.find((key) => textByKey[key] === text))

  return isValidOptionOrder(order) ? order : null
}

export function isValidOptionOrder(order) {
  return (
    Array.isArray(order) &&
    order.length === OPTION_KEYS.length &&
    [...order].sort().join('') === OPTION_KEYS.join('')
  )
}

export function applyOptionOrder(question, order) {
  if (!question.optionTextByKey || !isValidOptionOrder(order)) {
    return question
  }

  return { ...question, options: order.map((key) => question.optionTextByKey[key]) }
}

export function createSessionRecord({
  sessionId = createSessionId(),
  library,
  orderedQuestionIds,
  optionOrder = null,
  now = Date.now(),
}) {
  if (!Array.isArray(orderedQuestionIds) || orderedQuestionIds.length === 0) {
    throw new TypeError('orderedQuestionIds darf nicht leer sein.')
  }

  return {
    sessionId,
    libraryId: library.libraryId,
    libraryVersion: library.libraryVersion,
    activeQuestionIndexHash: library.activeQuestionIndexHash,
    // Revisionsstand der Fragen bei Rundenstart (fehlt bei Runden aus Phase 2B).
    questionRevisions: library.questionRevisions ? { ...library.questionRevisions } : null,
    sessionMode: SESSION_MODE_LEARNING,
    orderedQuestionIds: [...orderedQuestionIds],
    currentQuestionId: orderedQuestionIds[0],
    currentIndex: 0,
    currentQuestionState: {
      questionId: orderedQuestionIds[0],
      optionOrder,
      selectedOptionKey: null,
      isCorrect: null,
    },
    answeredQuestionIds: [],
    correctQuestionIds: [],
    sessionCorrectCount: 0,
    sessionIncorrectCount: 0,
    currentStreak: 0,
    bestSessionStreak: 0,
    sessionStartedAt: now,
    lastResumedAt: now,
    completed: false,
    completedAt: null,
  }
}

// Antwort-Ereignis auf die Session anwenden. Idempotent je Frage: eine in dieser Session
// bereits beantwortete Frage wird nie ein zweites Mal gezählt.
export function applyAnswer(
  session,
  { questionId, isCorrect, selectedOptionKey = null, optionOrder = null },
) {
  if (session.completed) {
    return { applied: false, reason: 'completed', session }
  }

  if (!session.orderedQuestionIds.includes(questionId)) {
    return { applied: false, reason: 'unknownQuestion', session }
  }

  if (session.answeredQuestionIds.includes(questionId)) {
    return { applied: false, reason: 'duplicate', session }
  }

  const streak = isCorrect ? session.currentStreak + 1 : 0
  const keepOrder = session.currentQuestionState?.questionId === questionId
  const storedOrder = keepOrder ? session.currentQuestionState.optionOrder : null

  return {
    applied: true,
    session: {
      ...session,
      // Die Frage, auf die geantwortet wurde, ist die aktuelle Frage (Reihenfolge-ID gewinnt).
      currentQuestionId: questionId,
      currentIndex: session.orderedQuestionIds.indexOf(questionId),
      currentQuestionState: {
        questionId,
        optionOrder: isValidOptionOrder(storedOrder) ? storedOrder : optionOrder,
        selectedOptionKey,
        isCorrect,
      },
      answeredQuestionIds: [...session.answeredQuestionIds, questionId],
      correctQuestionIds: isCorrect
        ? [...session.correctQuestionIds, questionId]
        : session.correctQuestionIds,
      sessionCorrectCount: session.sessionCorrectCount + (isCorrect ? 1 : 0),
      sessionIncorrectCount: session.sessionIncorrectCount + (isCorrect ? 0 : 1),
      currentStreak: streak,
      bestSessionStreak: Math.max(session.bestSessionStreak, streak),
    },
  }
}

// Wechsel zur nächsten Frage ("Weiter"). Der UI-State der vorigen Frage wird verworfen.
export function advanceSession(session, { questionId, optionOrder = null }) {
  const index = session.orderedQuestionIds.indexOf(questionId)

  if (session.completed || index === -1) {
    throw new Error('Ungültiger Wechsel: Frage gehört nicht zur aktiven Lernrunde.')
  }

  return {
    ...session,
    currentQuestionId: questionId,
    currentIndex: index,
    currentQuestionState: { questionId, optionOrder, selectedOptionKey: null, isCorrect: null },
  }
}

export function completeSession(session, now = Date.now()) {
  return { ...session, completed: true, completedAt: now }
}

// Übernahme einer bestätigten, kompatiblen Library-Änderung in eine laufende Runde.
// Nur bei unveränderter ID-Menge (kein Neu-Mapping der Reihenfolge); sonst bleibt die Runde
// unverändert und weiterhin blockiert. Fragenspezifischer UI-Zustand (Optionsreihenfolge,
// gewählte Option) einer überarbeiteten aktuellen Frage wird verworfen – Optionstexte und
// -positionen können sich mit einer neuen contentRevision geändert haben.
export function migrateSessionToLibrary(session, library, revisedQuestionIds = []) {
  const ordered = new Set(session.orderedQuestionIds)
  const sameIds =
    library.questionRevisions &&
    Object.keys(library.questionRevisions).length === ordered.size &&
    Object.keys(library.questionRevisions).every((id) => ordered.has(id))

  if (session.completed || !sameIds) {
    return { migrated: false, session }
  }

  const state = session.currentQuestionState
  const staleState = state && revisedQuestionIds.includes(state.questionId)

  return {
    migrated: true,
    session: {
      ...session,
      libraryVersion: library.libraryVersion,
      activeQuestionIndexHash: library.activeQuestionIndexHash,
      questionRevisions: { ...library.questionRevisions },
      currentQuestionState: staleState
        ? { questionId: state.questionId, optionOrder: null, selectedOptionKey: null, isCorrect: state.isCorrect }
        : state,
    },
  }
}

export function sessionStats(session) {
  const answeredCount = session.answeredQuestionIds.length
  const correctCount = session.correctQuestionIds.length

  return {
    totalCount: session.orderedQuestionIds.length,
    answeredCount,
    correctCount,
    incorrectCount: answeredCount - correctCount,
    remainingCount: session.orderedQuestionIds.length - answeredCount,
  }
}

function invalid(reason, extra = {}) {
  return { status: SESSION_STATUS.RESUME_REQUIRES_MIGRATION, reason, ...extra }
}

function hasValidShape(session) {
  const ordered = session.orderedQuestionIds
  const orderedSet = new Set(ordered)

  return (
    session.sessionMode === SESSION_MODE_LEARNING &&
    Array.isArray(ordered) &&
    ordered.length > 0 &&
    orderedSet.size === ordered.length &&
    Array.isArray(session.answeredQuestionIds) &&
    Array.isArray(session.correctQuestionIds) &&
    new Set(session.answeredQuestionIds).size === session.answeredQuestionIds.length &&
    session.answeredQuestionIds.every((id) => orderedSet.has(id)) &&
    session.correctQuestionIds.every((id) => session.answeredQuestionIds.includes(id))
  )
}

// Entscheidet, ob eine gespeicherte Session gegen die geladene Library fortgesetzt werden darf.
// Keine automatische Reparatur: bei Abweichungen wird kontrolliert blockiert.
export function evaluateSession(session, library, questions) {
  if (!session) {
    return { status: SESSION_STATUS.NONE }
  }

  if (session.completed) {
    return { status: SESSION_STATUS.COMPLETED, session, stats: sessionStats(session) }
  }

  if (!hasValidShape(session)) {
    return invalid('invalidSession', { session })
  }

  if (session.activeQuestionIndexHash !== library.activeQuestionIndexHash) {
    return invalid('hashChanged', { session })
  }

  const questionsById = new Map(questions.map((question) => [question.id, question]))
  const missingQuestionIds = session.orderedQuestionIds.filter((id) => !questionsById.has(id))
  const orderedSet = new Set(session.orderedQuestionIds)
  const extraQuestionIds = questions.map((question) => question.id).filter((id) => !orderedSet.has(id))

  if (missingQuestionIds.length > 0 || extraQuestionIds.length > 0) {
    return invalid('questionsChanged', { session, missingQuestionIds, extraQuestionIds })
  }

  // Defense in Depth zum Hash: stimmen die beim Rundenstart gemerkten Revisionen noch?
  if (session.questionRevisions && library.questionRevisions) {
    const revisionChanged = session.orderedQuestionIds.filter(
      (id) => session.questionRevisions[id] !== library.questionRevisions[id],
    )

    if (revisionChanged.length > 0) {
      return invalid('revisionsChanged', { session, revisedQuestionIds: revisionChanged })
    }
  }

  // currentQuestionId gewinnt; der Index wird daraus rekonstruiert. Nur ohne gültige ID
  // wird auf einen gültigen gespeicherten Index zurückgegriffen.
  let currentQuestionId = session.currentQuestionId
  let indexCorrected = false

  if (orderedSet.has(currentQuestionId)) {
    const index = session.orderedQuestionIds.indexOf(currentQuestionId)
    indexCorrected = session.currentIndex !== index
  } else if (Number.isInteger(session.currentIndex) && session.orderedQuestionIds[session.currentIndex]) {
    currentQuestionId = session.orderedQuestionIds[session.currentIndex]
    indexCorrected = true
  } else {
    return invalid('currentQuestionMissing', { session })
  }

  const currentIndex = session.orderedQuestionIds.indexOf(currentQuestionId)
  const state = session.currentQuestionState
  // UI-State gilt nur für genau diese Question-ID, nie für eine andere.
  const currentState = state && state.questionId === currentQuestionId ? state : null

  return {
    status: SESSION_STATUS.RESUMABLE,
    session,
    orderedQuestions: session.orderedQuestionIds.map((id) => questionsById.get(id)),
    currentQuestionId,
    currentIndex,
    currentState,
    indexCorrected,
    stats: sessionStats(session),
  }
}
