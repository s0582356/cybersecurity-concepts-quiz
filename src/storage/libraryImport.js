// Abgleich einer geladenen V2-Library mit dem gespeicherten Library-State.
//
// Phase 2A: Erkennung nur über libraryId, Entscheidung über activeQuestionIndexHash.
// Bei geändertem Hash wird nichts verändert und nichts migriert (Phase 2C).

export const IMPORT_STATUS = {
  NEW: 'new',
  KNOWN: 'known',
  VERSION_UPDATED: 'versionUpdated',
  UPDATE_REQUIRES_MIGRATION: 'updateRequiresMigration',
}

function parseSemver(version) {
  return version.split('.').map(Number)
}

function compareVersions(left, right) {
  const leftParts = parseSemver(left)
  const rightParts = parseSemver(right)

  for (let index = 0; index < 3; index++) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] > rightParts[index] ? 1 : -1
    }
  }

  return 0
}

export async function registerLibraryImport(store, library, { now = Date.now() } = {}) {
  const known = await store.getLibraryState(library.libraryId)

  if (!known) {
    const libraryState = {
      libraryId: library.libraryId,
      libraryVersion: library.libraryVersion,
      activeQuestionIndexHash: library.activeQuestionIndexHash,
      firstImportedAt: now,
      lastAccessedAt: now,
    }

    await store.upsertLibraryState(libraryState)

    return { status: IMPORT_STATUS.NEW, libraryState }
  }

  const versionRelation = compareVersions(library.libraryVersion, known.libraryVersion)

  if (known.activeQuestionIndexHash !== library.activeQuestionIndexHash) {
    // Gespeicherter Stand bleibt unangetastet, bis die Migration (Phase 2C) existiert.
    return {
      status: IMPORT_STATUS.UPDATE_REQUIRES_MIGRATION,
      libraryState: known,
      reason: 'hash-changed',
      versionRelation: ['older', 'same', 'newer'][versionRelation + 1],
    }
  }

  // Gleicher Hash: Fortschritt bleibt. Eine höhere Version wird übernommen,
  // eine ältere Datei senkt die gespeicherte Version nicht.
  const libraryState = {
    ...known,
    libraryVersion: versionRelation > 0 ? library.libraryVersion : known.libraryVersion,
    lastAccessedAt: now,
  }

  await store.upsertLibraryState(libraryState)

  return {
    status: versionRelation > 0 ? IMPORT_STATUS.VERSION_UPDATED : IMPORT_STATUS.KNOWN,
    libraryState,
  }
}
