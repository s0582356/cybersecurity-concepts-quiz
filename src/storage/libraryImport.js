// Abgleich einer geladenen V2-Library mit dem gespeicherten Library-State.
//
// Erkennung nur über libraryId, Entscheidung über activeQuestionIndexHash:
// - Hash gleich: gleiche aktive Fragenlandschaft (Fälle A/B), Metadaten werden nachgeführt.
// - Hash anders: Migration-State (Fall C). Es wird nichts verändert; nur eine kompatible
//   Änderung (revisionsOnly/questionsAdded) kann der Nutzer danach bewusst übernehmen.

import { CHANGE_KIND, classifyHashChange, compareVersions } from '../domain/libraryUpdate.js'

export { CHANGE_KIND }

export const IMPORT_STATUS = {
  NEW: 'new',
  KNOWN: 'known',
  VERSION_UPDATED: 'versionUpdated',
  UPDATE_REQUIRES_MIGRATION: 'updateRequiresMigration',
}

export async function registerLibraryImport(store, library, { now = Date.now() } = {}) {
  const known = await store.getLibraryState(library.libraryId)

  if (!known) {
    const libraryState = {
      libraryId: library.libraryId,
      libraryVersion: library.libraryVersion,
      activeQuestionIndexHash: library.activeQuestionIndexHash,
      questionRevisions: library.questionRevisions,
      firstImportedAt: now,
      lastAccessedAt: now,
    }

    await store.upsertLibraryState(libraryState)

    return { status: IMPORT_STATUS.NEW, libraryState }
  }

  if (known.activeQuestionIndexHash !== library.activeQuestionIndexHash) {
    // Gespeicherter Stand bleibt unangetastet.
    return {
      status: IMPORT_STATUS.UPDATE_REQUIRES_MIGRATION,
      libraryState: known,
      reason: 'hash-changed',
      ...classifyHashChange(known, library),
    }
  }

  // Gleicher Hash: Fortschritt und Session bleiben. Eine höhere Version wird übernommen,
  // eine ältere Datei senkt die gespeicherte Version nicht.
  const versionRelation = compareVersions(library.libraryVersion, known.libraryVersion)
  const libraryState = {
    ...known,
    libraryVersion: versionRelation > 0 ? library.libraryVersion : known.libraryVersion,
    // Revisionsstand nachtragen (Zustände aus Phase 2A/2B kennen ihn noch nicht).
    questionRevisions: known.questionRevisions ?? library.questionRevisions,
    lastAccessedAt: now,
    ...(versionRelation > 0 && { updatedAt: now }),
  }

  await store.upsertLibraryState(libraryState)

  return {
    status: versionRelation > 0 ? IMPORT_STATUS.VERSION_UPDATED : IMPORT_STATUS.KNOWN,
    libraryState,
  }
}

// Bewusst bestätigte Übernahme einer kompatiblen Änderung (neue Fragen / höhere contentRevision).
// Fortschritt wird weder gelöscht noch kopiert; eine laufende Runde wird nur migriert, wenn ihre
// Fragen-IDs unverändert sind (keine neue Reihenfolge).
export async function applyLibraryUpdate(store, library, { now = Date.now() } = {}) {
  const known = await store.getLibraryState(library.libraryId)

  if (!known || known.activeQuestionIndexHash === library.activeQuestionIndexHash) {
    throw new Error('Kein Update zu übernehmen.')
  }

  const classification = classifyHashChange(known, library)

  if (!classification.compatible) {
    throw new Error('Diese Änderung kann noch nicht übernommen werden.')
  }

  return store.applyCompatibleUpdate({
    library,
    previousHash: known.activeQuestionIndexHash,
    revisedQuestionIds: classification.change.revised,
    now,
  })
}
