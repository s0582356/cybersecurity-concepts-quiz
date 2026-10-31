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

// Übernahme einer bestätigten Library-Änderung MIT Ersetzungen in eine laufende Runde (Phase 2D).
// Der Contract regelt Sessions bei Replacement nicht ausdrücklich; deshalb gilt nur der sichere Fall:
// jede retired ID der Runde hat ein Ziel **in derselben Library** (Runden sind je Library, eine Runde
// kann keine Frage einer anderen Library enthalten). Sonst bleibt die Runde unverändert blockiert.
//  - Ziel noch nicht in der Runde: es übernimmt den Platz der retired ID (Position bleibt stabil).
//  - Ziel bereits in der Runde (oder von einer früheren retired ID belegt): der Platz der retired ID
//    entfällt, das Ziel behält seinen eigenen Platz → jede Frage höchstens einmal.
//  - Rundenguthaben: `inherit` überträgt „in dieser Runde beantwortet/richtig“ nur auf ein Ziel, das in
//    der Runde noch nicht beantwortet ist (kein zweites Zählen); `reset` und entfallene Plätze geben
//    kein Guthaben weiter. Zähler und Serien werden aus dem verbleibenden Verlauf neu abgeleitet
//    (`deriveStreaks`), damit entferntes Guthaben nicht als Serie fortwirkt.
//  - Fragenspezifischer UI-Zustand (Auswahl, Optionsreihenfolge) wird nie übertragen.
export function migrateSessionReplacements(session, library, replacements = [], revisedQuestionIds = []) {
  const blocked = (reason) => ({ migrated: false, reason, session })
  const active = new Set(Object.keys(library.questionRevisions ?? {}))

  if (session.completed || active.size === 0) {
    return blocked('notApplicable')
  }

  const byFrom = new Map(replacements.map((replacement) => [replacement.from, replacement]))
  const inSession = new Set(session.orderedQuestionIds)
  const newOrder = []
  const placed = new Set()
  const slotTarget = new Map()
  const dropIndex = new Map()

  for (const id of session.orderedQuestionIds) {
    if (active.has(id)) {
      if (!placed.has(id)) {
        newOrder.push(id)
        placed.add(id)
      }

      continue
    }

    const replacement = byFrom.get(id)

    if (!replacement || replacement.targetLibraryId !== library.libraryId || !active.has(replacement.to)) {
      return blocked('unmappable')
    }

    if (inSession.has(replacement.to) || placed.has(replacement.to)) {
      slotTarget.set(id, null)
      dropIndex.set(id, newOrder.length)
    } else {
      slotTarget.set(id, replacement.to)
      newOrder.push(replacement.to)
      placed.add(replacement.to)
    }
  }

  if (newOrder.length !== active.size || !newOrder.every((id) => active.has(id))) {
    return blocked('questionsChanged')
  }

  const wasAnswered = new Set(session.answeredQuestionIds)
  const wasCorrect = new Set(session.correctQuestionIds)
  const answeredQuestionIds = []
  const correctQuestionIds = []
  const credit = (id, correct) => {
    if (!answeredQuestionIds.includes(id)) {
      answeredQuestionIds.push(id)

      if (correct) {
        correctQuestionIds.push(id)
      }
    }
  }

  session.answeredQuestionIds.forEach((id) => {
    if (active.has(id)) {
      credit(id, wasCorrect.has(id))
      return
    }

    const target = slotTarget.get(id)

    if (target && byFrom.get(id).policy === 'inherit' && !wasAnswered.has(target)) {
      credit(target, wasCorrect.has(id))
    }
  })

  let currentQuestionId = session.currentQuestionId

  if (!active.has(currentQuestionId)) {
    const target = slotTarget.get(currentQuestionId)

    currentQuestionId = target ?? newOrder[Math.min(dropIndex.get(currentQuestionId) ?? 0, newOrder.length - 1)]
  }

  const state = session.currentQuestionState
  const keepState =
    state && state.questionId === currentQuestionId && !revisedQuestionIds.includes(currentQuestionId)

  return {
    migrated: true,
    session: {
      ...session,
      libraryVersion: library.libraryVersion,
      activeQuestionIndexHash: library.activeQuestionIndexHash,
      questionRevisions: { ...library.questionRevisions },
      orderedQuestionIds: newOrder,
      currentQuestionId,
      currentIndex: newOrder.indexOf(currentQuestionId),
      currentQuestionState: keepState
        ? state
        : {
            questionId: currentQuestionId,
            optionOrder: null,
            selectedOptionKey: null,
            isCorrect: answeredQuestionIds.includes(currentQuestionId)
              ? correctQuestionIds.includes(currentQuestionId)
              : null,
          },
      answeredQuestionIds,
      correctQuestionIds,
      sessionCorrectCount: correctQuestionIds.length,
      sessionIncorrectCount: answeredQuestionIds.length - correctQuestionIds.length,
      ...deriveStreaks(answeredQuestionIds, correctQuestionIds),
    },
  }
}

// Serien aus dem Antwortverlauf der Runde. `answeredQuestionIds` ist chronologisch (jede Antwort wird
// angehängt), `correctQuestionIds` die richtigen davon; damit entspricht das exakt der laufenden
// Regel in `applyAnswer` (richtig: +1, falsch: 0, Bestwert = Maximum). Es gibt keine
// Lifetime-Semantik; die Serie gehört nur zu dieser Runde.
export function deriveStreaks(answeredQuestionIds, correctQuestionIds) {
  const correct = new Set(correctQuestionIds)
  let currentStreak = 0
  let bestSessionStreak = 0

  for (const id of answeredQuestionIds) {
    currentStreak = correct.has(id) ? currentStreak + 1 : 0
    bestSessionStreak = Math.max(bestSessionStreak, currentStreak)
  }

  return { currentStreak, bestSessionStreak }
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

export function hasValidShape(session) {
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
