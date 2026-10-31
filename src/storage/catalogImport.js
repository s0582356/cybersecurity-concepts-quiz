// Mehrfach-Import von V2-Libraries (Phase 2E).
//
// Jede Datei bekommt ein eigenes, nachvollziehbares Ergebnis; eine ungültige oder abgelehnte
// Datei verhindert nie den Import der übrigen. Für jede einzelne Library gelten unverändert die
// Regeln aus Phase 2A–2D (registerLibraryImport / applyLibraryUpdate): bei geändertem Fragenstand
// wird nichts verändert, sondern ein bestätigbares Update (ggf. mit Replacement) gemeldet.

import { BATCH_REASON, BATCH_STATUS, planLibraryBatch, summarizeBatch } from '../domain/libraryCatalog.js'
import { CHANGE_KIND } from '../domain/libraryUpdate.js'
import { describeUpdate } from '../domain/updateDescription.js'
import { IMPORT_STATUS, applyLibraryUpdate, registerLibraryImport } from './libraryImport.js'

export const BATCH_RESULT_MESSAGE = {
  [BATCH_STATUS.NEW]: 'Neue Bibliothek erkannt. Dein Fortschritt wird ab jetzt lokal im Browser gespeichert.',
  [BATCH_STATUS.KNOWN]: 'Bekannte Bibliothek erkannt. Gespeicherter Fortschritt wird verwendet.',
  [BATCH_STATUS.VERSION_UPDATED]:
    'Bekannte Bibliothek in neuerer Version erkannt. Gespeicherter Fortschritt bleibt erhalten.',
}

const RETIRED_INDEX_LOADED = 'retiredIndexLoaded'

export const BATCH_STATUS_LABEL = {
  [BATCH_STATUS.NEW]: 'Neu importiert',
  [BATCH_STATUS.KNOWN]: 'Bereits aktuell',
  [BATCH_STATUS.VERSION_UPDATED]: 'Aktualisiert',
  [BATCH_STATUS.UPDATE_PENDING]: 'Update benötigt Bestätigung',
  [BATCH_STATUS.REPLACEMENT_PENDING]: 'Replacement-Migration benötigt Bestätigung',
  [BATCH_STATUS.UPDATE_BLOCKED]: 'Update nicht übernehmbar',
  [BATCH_STATUS.INVALID]: 'Ungültig',
  [BATCH_STATUS.REJECTED]: 'Abgelehnt',
  [BATCH_STATUS.SKIPPED]: 'Übersprungen',
  [RETIRED_INDEX_LOADED]: 'Ersetzungsliste geladen',
}

// Kategorie für die Darstellung: info = in Ordnung, warning = braucht Entscheidung, error = nicht importiert.
export function resultSeverity(status) {
  if ([BATCH_STATUS.NEW, BATCH_STATUS.KNOWN, BATCH_STATUS.VERSION_UPDATED, RETIRED_INDEX_LOADED].includes(status)) {
    return 'info'
  }

  return 'error'
}

function resultFor(entry, status, extra = {}) {
  return {
    fileName: entry.fileName,
    libraryId: entry.library?.libraryId ?? null,
    title: entry.library?.title ?? null,
    learningSectionId: entry.library?.learningSectionId ?? null,
    status,
    ...extra,
  }
}

async function importOne(store, entry, { retiredIndex, now }) {
  const { library, questions } = entry

  try {
    const outcome = await registerLibraryImport(store, library, { questions, retiredIndex, now })

    if (outcome.status === IMPORT_STATUS.REJECTED) {
      return {
        result: resultFor(entry, BATCH_STATUS.REJECTED, {
          reason: outcome.reason,
          conflictingLibraryIds: outcome.conflictingLibraryIds,
          message: `${outcome.message} Die Library wird nicht importiert; nichts wurde überschrieben.`,
        }),
      }
    }

    if (outcome.status === IMPORT_STATUS.UPDATE_REQUIRES_MIGRATION) {
      const description = describeUpdate(outcome)
      const status = !description.compatible
        ? BATCH_STATUS.UPDATE_BLOCKED
        : outcome.changeKind === CHANGE_KIND.QUESTIONS_REPLACED
          ? BATCH_STATUS.REPLACEMENT_PENDING
          : BATCH_STATUS.UPDATE_PENDING

      return {
        result: resultFor(entry, status, { changeKind: outcome.changeKind, message: description.text }),
        pending: description.compatible ? entry : null,
      }
    }

    const status = {
      [IMPORT_STATUS.NEW]: BATCH_STATUS.NEW,
      [IMPORT_STATUS.KNOWN]: BATCH_STATUS.KNOWN,
      [IMPORT_STATUS.VERSION_UPDATED]: BATCH_STATUS.VERSION_UPDATED,
    }[outcome.status]

    return { result: resultFor(entry, status, { message: BATCH_RESULT_MESSAGE[status] }) }
  } catch (error) {
    return {
      result: resultFor(entry, BATCH_STATUS.REJECTED, {
        reason: 'storage-error',
        message: `Die Library konnte nicht gespeichert werden: ${error.message}`,
      }),
    }
  }
}

// entries: { fileName, kind: 'v2' | 'v1' | 'retiredIndex' | 'invalid', library, questions, retiredIndex, error }
export async function importLibraryBatch(store, entries, { retiredIndex = null, now = Date.now() } = {}) {
  const results = []
  let activeRetiredIndex = retiredIndex
  const retiredEntries = entries.filter((entry) => entry.kind === 'retiredIndex')

  // Die Ersetzungsliste wird zuerst geladen, damit Updates im selben Batch sie nutzen können.
  if (retiredEntries.length > 1) {
    retiredEntries.forEach((entry) =>
      results.push(
        resultFor(entry, BATCH_STATUS.REJECTED, {
          reason: BATCH_REASON.MULTIPLE_RETIRED_INDEXES,
          message: 'Mehrere Ersetzungslisten im selben Batch; keine davon wurde geladen. Bitte nur eine auswählen.',
        }),
      ),
    )
  } else if (retiredEntries.length === 1) {
    const [entry] = retiredEntries

    try {
      await store.saveRetiredIndex(entry.retiredIndex, now)
      activeRetiredIndex = entry.retiredIndex
      results.push(
        resultFor(entry, RETIRED_INDEX_LOADED, {
          message: `Ersetzungsliste geladen (${Object.keys(entry.retiredIndex).length} Einträge). Sie wird bei Bibliotheks-Updates verwendet.`,
        }),
      )
    } catch (error) {
      results.push(
        resultFor(entry, BATCH_STATUS.REJECTED, {
          reason: 'storage-error',
          message: `Ersetzungsliste konnte nicht gespeichert werden: ${error.message}`,
        }),
      )
    }
  }

  const plan = planLibraryBatch(entries, await store.listLibraryStates())
  const pending = new Map()

  results.push(...plan.results)

  for (const entry of plan.importable) {
    const { result, pending: pendingEntry } = await importOne(store, entry, { retiredIndex: activeRetiredIndex, now })

    results.push(result)

    if (pendingEntry) {
      pending.set(entry.library.libraryId, pendingEntry)
    }
  }

  return {
    results: results.sort((a, b) => a.fileName.localeCompare(b.fileName)),
    summary: summarizeBatch(entries, plan.importable),
    pending,
    retiredIndex: activeRetiredIndex,
  }
}

// Bewusst bestätigte Übernahme eines Updates aus einem Batch (Phase 2C/2D-Logik, atomar inkl. Fragen).
export async function confirmPendingUpdate(store, entry, { retiredIndex = null, now = Date.now() } = {}) {
  return applyLibraryUpdate(store, entry.library, { questions: entry.questions, retiredIndex, now })
}
