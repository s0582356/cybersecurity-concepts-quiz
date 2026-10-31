// Abgleich einer geladenen V2-Library mit dem gespeicherten Library-State.
//
// Erkennung nur über libraryId, Entscheidung über activeQuestionIndexHash:
// - Hash gleich: gleiche aktive Fragenlandschaft (Fälle A/B), Metadaten werden nachgeführt.
// - Hash anders: Migration-State (Fall C). Es wird nichts verändert; nur eine kompatible
//   Änderung (revisionsOnly/questionsAdded) kann der Nutzer danach bewusst übernehmen.

import { CHANGE_KIND, classifyHashChange, compareVersions } from '../domain/libraryUpdate.js'
import { findDuplicateQuestionIds } from '../domain/libraryCatalog.js'
import { LocalizedError, msg } from '../i18n/index.js'

export { CHANGE_KIND }

export const IMPORT_STATUS = {
  NEW: 'new',
  KNOWN: 'known',
  VERSION_UPDATED: 'versionUpdated',
  UPDATE_REQUIRES_MIGRATION: 'updateRequiresMigration',
  // Phase 2E: Import wird kontrolliert abgelehnt (nichts geschrieben); `reason` nennt den Grund.
  REJECTED: 'rejected',
}

export const REJECT_REASON = {
  DUPLICATE_QUESTION_IDS: 'duplicate-question-ids',
  SECTION_CHANGED: 'section-changed',
}

// Phase 2E: Katalog-Metadaten, die zusätzlich zum Revisionsstand am Library-State stehen.
function catalogFields(library) {
  return {
    title: library.title,
    learningSectionId: library.learningSectionId,
    questionCount: library.questionCount,
  }
}

// Phase 2F: Sprachabdeckung gehört zu den gespeicherten Fragen und wird nur gemeinsam mit ihnen geschrieben.
function languageFields(library) {
  return {
    ...(library.languageSupport && { languageSupport: library.languageSupport }),
    ...(library.contentCoverage && { contentCoverage: library.contentCoverage }),
  }
}

// Dieselbe aktive Question-ID darf nicht in zwei Libraries aktiv sein (Contract). Nichts wird überschrieben.
async function checkRules(store, library, known) {
  if (known?.learningSectionId && library.learningSectionId && known.learningSectionId !== library.learningSectionId) {
    return {
      status: IMPORT_STATUS.REJECTED,
      reason: REJECT_REASON.SECTION_CHANGED,
      message: msg('reject.sectionChanged', { from: known.learningSectionId, to: library.learningSectionId }),
    }
  }

  const others = await otherLibraryStates(store, library)
  const clash = findDuplicateQuestionIds([{ library }], others).get(library.libraryId)

  if (clash) {
    return {
      status: IMPORT_STATUS.REJECTED,
      reason: REJECT_REASON.DUPLICATE_QUESTION_IDS,
      conflictingLibraryIds: [...clash.libraries].sort(),
      message: msg('reject.duplicateIds', { count: clash.ids.length, libraries: [...clash.libraries].sort().join(', ') }),
    }
  }

  return null
}

export async function registerLibraryImport(
  store,
  library,
  { now = Date.now(), retiredIndex = null, questions = null } = {},
) {
  const known = await store.getLibraryState(library.libraryId)
  const rejection = await checkRules(store, library, known)

  if (rejection) {
    return rejection
  }

  if (!known) {
    const libraryState = {
      libraryId: library.libraryId,
      libraryVersion: library.libraryVersion,
      activeQuestionIndexHash: library.activeQuestionIndexHash,
      questionRevisions: library.questionRevisions,
      firstImportedAt: now,
      lastAccessedAt: now,
      ...catalogFields(library),
      ...(questions && languageFields(library)),
    }

    await store.upsertLibraryState(libraryState, { questions })

    return { status: IMPORT_STATUS.NEW, libraryState }
  }

  if (known.activeQuestionIndexHash !== library.activeQuestionIndexHash) {
    // Gespeicherter Stand bleibt unangetastet.
    return {
      status: IMPORT_STATUS.UPDATE_REQUIRES_MIGRATION,
      libraryState: known,
      reason: 'hash-changed',
      ...classifyHashChange(known, library, { retiredIndex, otherStates: await otherLibraryStates(store, library) }),
    }
  }

  // Gleicher Hash: Fortschritt und Session bleiben. Eine höhere Version wird übernommen,
  // eine ältere Datei senkt die gespeicherte Version nicht.
  const versionRelation = compareVersions(library.libraryVersion, known.libraryVersion)
  // Fragen werden gespeichert, wenn sie fehlen (Zustand ≤ 2D) oder die Datei eine höhere Version hat.
  const needsContent =
    Boolean(questions) &&
    (versionRelation > 0 || !known.learningSectionId || !(await store.getLibraryContent(library.libraryId)))
  const libraryState = {
    ...known,
    libraryVersion: versionRelation > 0 ? library.libraryVersion : known.libraryVersion,
    // Revisionsstand nachtragen (Zustände aus Phase 2A/2B kennen ihn noch nicht).
    questionRevisions: known.questionRevisions ?? library.questionRevisions,
    lastAccessedAt: now,
    ...(versionRelation > 0 && { updatedAt: now }),
    // Zustände aus Phase ≤ 2D kennen Abschnitt/Titel noch nicht: nachtragen (Fortschritt bleibt unberührt).
    ...catalogFields(library),
    // Sprachabdeckung ändert sich nur zusammen mit den gespeicherten Fragen.
    ...(needsContent && languageFields(library)),
  }

  await store.upsertLibraryState(libraryState, { questions: needsContent ? questions : null })

  return {
    status: versionRelation > 0 ? IMPORT_STATUS.VERSION_UPDATED : IMPORT_STATUS.KNOWN,
    libraryState,
  }
}

// Bewusst bestätigte Übernahme einer kompatiblen Änderung (neue Fragen / höhere contentRevision).
// Fortschritt wird weder gelöscht noch kopiert; eine laufende Runde wird nur migriert, wenn ihre
// Fragen-IDs unverändert sind (keine neue Reihenfolge).
async function otherLibraryStates(store, library) {
  return (await store.listLibraryStates()).filter((state) => state.libraryId !== library.libraryId)
}

export async function applyLibraryUpdate(store, library, { now = Date.now(), retiredIndex = null, questions = null } = {}) {
  const known = await store.getLibraryState(library.libraryId)

  if (!known || known.activeQuestionIndexHash === library.activeQuestionIndexHash) {
    throw new LocalizedError('err.update.none')
  }

  const rejection = await checkRules(store, library, known)

  if (rejection) {
    throw new LocalizedError(rejection.message.i18n, rejection.message.params)
  }

  const classification = classifyHashChange(known, library, {
    retiredIndex,
    otherStates: await otherLibraryStates(store, library),
  })

  if (!classification.compatible) {
    throw new LocalizedError('err.update.incompatible')
  }

  return store.applyCompatibleUpdate({
    library,
    previousHash: known.activeQuestionIndexHash,
    revisedQuestionIds: classification.change.revised,
    replacements: classification.replacements ?? [],
    questions,
    now,
  })
}
