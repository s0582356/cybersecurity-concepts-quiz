// Lernrunde über einen ganzen Lernabschnitt (Phase 2E): Fragen aller zugehörigen Libraries.
//
// Session-Identität: genau eine Runde je Lernabschnitt, deterministischer Scope-Key
// `section:<learningSectionId>` (im bestehenden Index `byLibrary` abgelegt, daher keine neue
// Indexstruktur). `sessionId` bleibt je Runde zufällig; die Identität des Abschnitts nicht.
// Question-IDs bleiben die stabilen IDs aus den Libraries; `questionLibraries` merkt sich nur,
// zu welcher Library eine ID gehört, damit Fortschritt weiter an (libraryId, questionId) hängt.
//
// Eine laufende Runde bleibt deterministisch: später importierte Fragen werden nie in
// `orderedQuestionIds` eingeschoben, sondern erst von der nächsten Runde aufgenommen.

import { hasValidEnglish } from './questionContent.js'
import {
  SESSION_MODE_LEARNING,
  SESSION_STATUS,
  hasValidShape,
  createSessionRecord,
  migrateSessionReplacements,
  sessionStats,
} from './session.js'

export function sectionScopeKey(sectionId) {
  return `section:${sectionId}`
}

// orderedQuestions: Quiz-Fragen ({ id, libraryId, contentRevision, ... }) in der gewürfelten Reihenfolge.
// libraries: Library-States des Abschnitts zum Rundenstart (nur Metadaten).
// Sprachangaben (DE/EN-Contract: aktive Sitzungssprache im Resume-Datensatz):
// - sessionLanguage        Inhaltssprache der Runde ('de' | 'en'); unabhängig von der Oberflächensprache
// - languageMode           'onlyEnglish' | 'allAvailable' bei Englisch (sonst null): bestimmt die Fragenmenge
// - skippedQuestionIds     bei "Nur Englisch" ausgelassene Fragen (nur IDs; für die sichtbare Kennzahl)
export function createSectionSessionRecord({
  sectionId,
  libraries,
  orderedQuestions,
  optionOrder = null,
  sessionLanguage = 'de',
  languageMode = null,
  skippedQuestionIds = [],
  ...rest
}) {
  const base = createSessionRecord({
    ...rest,
    library: { libraryId: sectionScopeKey(sectionId), libraryVersion: '0.0.0', activeQuestionIndexHash: null },
    orderedQuestionIds: orderedQuestions.map((question) => question.id),
    optionOrder,
  })

  // Versions-/Hash-Felder gehören zu einer einzelnen Library; hier stehen sie je Library in `libraries`.
  const { libraryVersion, activeQuestionIndexHash, ...record } = base

  void libraryVersion
  void activeQuestionIndexHash

  return {
    ...record,
    sectionId,
    sessionLanguage,
    languageMode,
    skippedQuestionIds: [...skippedQuestionIds],
    libraries: libraries.map((library) => ({
      libraryId: library.libraryId,
      libraryVersion: library.libraryVersion,
      activeQuestionIndexHash: library.activeQuestionIndexHash,
    })),
    questionLibraries: Object.fromEntries(orderedQuestions.map((question) => [question.id, question.libraryId])),
    questionRevisions: Object.fromEntries(orderedQuestions.map((question) => [question.id, question.contentRevision])),
  }
}

export function isSectionSession(session) {
  return Boolean(session?.sectionId)
}

// Neue Fragen seit Rundenstart. Fragen, die "Nur Englisch" bewusst ausgelassen hat, zählen nicht als neu – es sei denn,
// sie haben inzwischen gültiges Englisch (nur prüfbar, wenn echte Fragen statt Katalog-Metadaten übergeben werden).
function newQuestionCountOf(session, active, orderedSet) {
  const skipped = new Set(session.skippedQuestionIds ?? [])

  return [...active.values()].filter((question) => {
    if (orderedSet.has(question.id)) {
      return false
    }

    return !skipped.has(question.id) || (question.localized ? hasValidEnglish(question) : false)
  }).length
}

// Entscheidet, ob eine gespeicherte Abschnitts-Runde gegen den aktuellen Katalog fortgesetzt werden darf.
// `activeQuestions`: Map oder Liste von { id, libraryId, contentRevision } (Katalog-Metadaten oder echte Fragen).
// Keine automatische Reparatur. Neue Fragen im Abschnitt blockieren NICHT (sie kommen erst in der nächsten Runde).
export function evaluateSectionSession(session, activeQuestions) {
  if (!session) {
    return { status: SESSION_STATUS.NONE }
  }

  const active = activeQuestions instanceof Map ? activeQuestions : new Map(activeQuestions.map((question) => [question.id, question]))
  const blocked = (reason, extra = {}) => ({ status: SESSION_STATUS.RESUME_REQUIRES_MIGRATION, reason, session, ...extra })

  if (session.completed) {
    return { status: SESSION_STATUS.COMPLETED, session, stats: sessionStats(session) }
  }

  if (!hasValidShape(session) || !session.questionLibraries || !session.questionRevisions) {
    return blocked('invalidSession')
  }

  const orderedSet = new Set(session.orderedQuestionIds)
  const missingQuestionIds = session.orderedQuestionIds.filter(
    (id) => !active.has(id) || active.get(id).libraryId !== session.questionLibraries[id],
  )

  if (missingQuestionIds.length > 0) {
    return blocked('questionsChanged', { missingQuestionIds, extraQuestionIds: [] })
  }

  const revisedQuestionIds = session.orderedQuestionIds.filter(
    (id) => session.questionRevisions[id] !== active.get(id).contentRevision,
  )

  if (revisedQuestionIds.length > 0) {
    return blocked('revisionsChanged', { revisedQuestionIds })
  }

  let currentQuestionId = session.currentQuestionId

  if (!orderedSet.has(currentQuestionId)) {
    if (Number.isInteger(session.currentIndex) && session.orderedQuestionIds[session.currentIndex]) {
      currentQuestionId = session.orderedQuestionIds[session.currentIndex]
    } else {
      return blocked('currentQuestionMissing')
    }
  }

  const state = session.currentQuestionState

  return {
    status: SESSION_STATUS.RESUMABLE,
    session,
    orderedQuestions: session.orderedQuestionIds.map((id) => active.get(id)),
    currentQuestionId,
    currentIndex: session.orderedQuestionIds.indexOf(currentQuestionId),
    currentState: state && state.questionId === currentQuestionId ? state : null,
    // Fragen, die seit Rundenstart zum Abschnitt hinzugekommen sind (erst ab der nächsten Runde).
    newQuestionCount: newQuestionCountOf(session, active, orderedSet),
    stats: sessionStats(session),
  }
}

// Übernahme einer bestätigten, kompatiblen Library-Änderung in laufende Abschnitts-Runden (Phase 2C-Semantik):
// nur Revisionsstand der eigenen Fragen nachziehen; nie die Reihenfolge ändern. Sind eigene Fragen der Runde
// nicht mehr aktiv (entfernt/ersetzt), bleibt die Runde unverändert (und damit kontrolliert blockiert).
export function migrateSectionSessionToLibrary(session, library, revisedQuestionIds = []) {
  if (session.completed || !isSectionSession(session) || session.sessionMode !== SESSION_MODE_LEARNING) {
    return { migrated: false, session }
  }

  const ownIds = session.orderedQuestionIds.filter((id) => session.questionLibraries?.[id] === library.libraryId)

  if (ownIds.length === 0 || !ownIds.every((id) => id in library.questionRevisions)) {
    return { migrated: false, session }
  }

  const state = session.currentQuestionState
  const staleState = state && ownIds.includes(state.questionId) && revisedQuestionIds.includes(state.questionId)

  return {
    migrated: true,
    session: {
      ...session,
      libraries: session.libraries.map((entry) =>
        entry.libraryId === library.libraryId
          ? { ...entry, libraryVersion: library.libraryVersion, activeQuestionIndexHash: library.activeQuestionIndexHash }
          : entry,
      ),
      questionRevisions: {
        ...session.questionRevisions,
        ...Object.fromEntries(ownIds.map((id) => [id, library.questionRevisions[id]])),
      },
      currentQuestionState: staleState
        ? { questionId: state.questionId, optionOrder: null, selectedOptionKey: null, isCorrect: state.isCorrect }
        : state,
    },
  }
}

// Übernahme einer bestätigten Library-Änderung MIT Ersetzungen in eine laufende Abschnitts-Runde.
// Die Ersetzungs-Regeln (Platz der retired ID, inherit/reset-Rundenguthaben, Serien, kein Doppelzählen) sind
// die aus Phase 2D (`migrateSessionReplacements`); hier wird nur der Abschnitt als "Library" dargestellt:
// aktiv sind alle noch aktiven Fragen der Runde plus die Ersetzungsziele. Ziele müssen im Abschnitt aktiv
// sein, sonst bleibt die Runde unverändert (kontrolliert blockiert).
// `sectionLibraries`: Library-Metadaten des Abschnitts NACH dem Update (inkl. der aktualisierten Library).
export function migrateSectionSessionReplacements(session, sectionLibraries, replacements, revisedQuestionIds = []) {
  if (session.completed || !isSectionSession(session)) {
    return { migrated: false, reason: 'notApplicable', session }
  }

  const sectionActive = new Map()

  sectionLibraries.forEach((library) =>
    Object.entries(library.questionRevisions).forEach(([id, revision]) =>
      sectionActive.set(id, { libraryId: library.libraryId, revision }),
    ),
  )

  const inSession = new Set(session.orderedQuestionIds)
  const activeIds = new Set(session.orderedQuestionIds.filter((id) => sectionActive.has(id)))

  replacements
    .filter((replacement) => inSession.has(replacement.from) && sectionActive.has(replacement.to))
    .forEach((replacement) => activeIds.add(replacement.to))

  const scopeKey = session.libraryId
  const result = migrateSessionReplacements(
    session,
    { libraryId: scopeKey, libraryVersion: '0.0.0', activeQuestionIndexHash: null, questionRevisions: Object.fromEntries([...activeIds].map((id) => [id, sectionActive.get(id).revision])) },
    replacements.map((replacement) => ({ ...replacement, targetLibraryId: scopeKey })),
    revisedQuestionIds,
  )

  if (!result.migrated) {
    return result
  }

  const migrated = result.session
  const ownerOf = (id) => sectionActive.get(id).libraryId
  const usedLibraryIds = new Set(migrated.orderedQuestionIds.map(ownerOf))
  // Versions-/Hash-Felder der Library-Session gehören nicht in eine Abschnitts-Runde.
  const { libraryVersion, activeQuestionIndexHash, ...record } = migrated

  void libraryVersion
  void activeQuestionIndexHash

  return {
    migrated: true,
    session: {
      ...record,
      libraries: sectionLibraries
        .filter((library) => usedLibraryIds.has(library.libraryId))
        .map((library) => ({
          libraryId: library.libraryId,
          libraryVersion: library.libraryVersion,
          activeQuestionIndexHash: library.activeQuestionIndexHash,
        })),
      questionLibraries: Object.fromEntries(migrated.orderedQuestionIds.map((id) => [id, ownerOf(id)])),
      questionRevisions: Object.fromEntries(migrated.orderedQuestionIds.map((id) => [id, sectionActive.get(id).revision])),
    },
  }
}
