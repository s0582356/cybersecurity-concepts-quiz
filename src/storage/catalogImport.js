// Mehrfach-Import von V2-Libraries (Phase 2E).
//
// Jede Datei bekommt ein eigenes, nachvollziehbares Ergebnis; eine ungültige oder abgelehnte
// Datei verhindert nie den Import der übrigen. Für jede einzelne Library gelten unverändert die
// Regeln aus Phase 2A–2D (registerLibraryImport / applyLibraryUpdate): bei geändertem Fragenstand
// wird nichts verändert, sondern ein bestätigbares Update (ggf. mit Replacement) gemeldet.

import { BATCH_REASON, BATCH_STATUS, planLibraryBatch, summarizeBatch } from '../domain/libraryCatalog.js'
import { CHANGE_KIND } from '../domain/libraryUpdate.js'
import { describeUpdate } from '../domain/updateDescription.js'
import { describeError, msg } from '../i18n/index.js'
import { IMPORT_STATUS, applyLibraryUpdate, registerLibraryImport } from './libraryImport.js'

// Sprachangaben einer importierten Library für den Import-Bericht (nur Zahlen und Hinweise).
export function languageInfo(library) {
  if (!library?.contentCoverage) {
    return null
  }

  const { de, en } = library.contentCoverage
  const declaresEnglish = library.languageSupport?.includes('en') ?? false
  const notes = []

  if (declaresEnglish && en < de) {
    notes.push(msg('import.language.declaredIncomplete', { en, total: de }))
  }

  if (!declaresEnglish && en === de && de > 0) {
    notes.push(msg('import.language.notDeclared'))
  }

  if (library.languageIssues?.length > 0) {
    notes.push(msg('import.language.issues', { count: library.languageIssues.length }))
  }

  return { de, en, declaresEnglish, notes }
}

export const BATCH_RESULT_MESSAGE = {
  [BATCH_STATUS.NEW]: msg('result.new'),
  [BATCH_STATUS.KNOWN]: msg('result.known'),
  [BATCH_STATUS.VERSION_UPDATED]: msg('result.versionUpdated'),
}

const RETIRED_INDEX_LOADED = 'retiredIndexLoaded'

// Übersetzbare Statusbezeichnungen (Schlüssel `status.<status>`).
export const batchStatusLabel = (status) => msg(`status.${status}`)

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
    languages: languageInfo(entry.library),
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
          message: msg('result.rejectedSuffix', { message: outcome.message }),
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
        result: resultFor(entry, status, { changeKind: outcome.changeKind, message: description.message }),
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
        message: msg('result.storageError', { detail: describeError(error) }),
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
          message: msg('batch.multipleRetired'),
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
          message: msg('result.retiredLoaded', { count: Object.keys(entry.retiredIndex).length }),
        }),
      )
    } catch (error) {
      results.push(
        resultFor(entry, BATCH_STATUS.REJECTED, {
          reason: 'storage-error',
          message: msg('result.retiredStorageError', { detail: describeError(error) }),
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
