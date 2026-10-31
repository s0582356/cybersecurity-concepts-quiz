// Library-Katalog und Lernabschnitts-Gruppierung (Phase 2E).
//
// Der Katalog ist keine eigene Persistenz: er wird aus den gespeicherten Library-States
// (Metadaten, Revisionsstand) abgeleitet. Gruppiert wird allein über `learningSectionId`
// (steht je Frage in der Library, siehe parseLibrary); Dateinamen spielen keine Rolle.
// Fortschritt bleibt an (libraryId, questionId) gebunden – hier wird nur gezählt, nie geschrieben.

import { msg } from '../i18n/index.js'
import { compareVersions } from './libraryUpdate.js'

const SECTION_NUMBER_PATTERN = /^la(\d+)$/

// Übersetzbarer Deskriptor; `sectionNumber` ist die sprachneutrale Kennung (la08 → 8).
export function sectionNumber(sectionId) {
  const match = SECTION_NUMBER_PATTERN.exec(sectionId)

  return match ? String(Number(match[1])) : sectionId
}

export function sectionLabel(sectionId) {
  return msg('section.label', { id: sectionNumber(sectionId) })
}

function compareSectionIds(left, right) {
  const leftNumber = SECTION_NUMBER_PATTERN.exec(left)
  const rightNumber = SECTION_NUMBER_PATTERN.exec(right)

  if (leftNumber && rightNumber) {
    return Number(leftNumber[1]) - Number(rightNumber[1])
  }

  if (leftNumber || rightNumber) {
    return leftNumber ? -1 : 1
  }

  return left.localeCompare(right)
}

// Ein State gehört zum Katalog, sobald er einen Lernabschnitt kennt (Import ab Phase 2E).
export function isCatalogState(state) {
  return Boolean(state?.learningSectionId && state.questionRevisions)
}

export function activeQuestionIdsOf(state) {
  return Object.keys(state.questionRevisions ?? {})
}

// Alle aktiven Fragen eines Lernabschnitts als Map id -> { id, libraryId, contentRevision }.
export function sectionActiveQuestions(states, sectionId) {
  const active = new Map()

  states
    .filter((state) => isCatalogState(state) && state.learningSectionId === sectionId)
    .forEach((state) => {
      Object.entries(state.questionRevisions).forEach(([id, contentRevision]) => {
        active.set(id, { id, libraryId: state.libraryId, contentRevision })
      })
    })

  return active
}

// Fortschritt eines Lernabschnitts: gezählt werden nur aktive Fragen der zugehörigen Libraries.
// Historische/retired Datensätze (und Datensätze fremder Libraries) zählen nie mit.
export function summarizeSectionProgress(libraryStates, progressRecords) {
  const recordsByKey = new Map(progressRecords.map((record) => [`${record.libraryId}::${record.questionId}`, record]))
  const summary = { totalQuestions: 0, answeredCount: 0, lastCorrectCount: 0, lastIncorrectCount: 0, totalAttempts: 0 }

  libraryStates.forEach((state) => {
    activeQuestionIdsOf(state).forEach((id) => {
      summary.totalQuestions++

      const record = recordsByKey.get(`${state.libraryId}::${id}`)

      if (!record?.answered || record.historical) {
        return
      }

      summary.answeredCount++
      summary.totalAttempts += record.attempts

      if (record.lastResult === 'correct') {
        summary.lastCorrectCount++
      } else {
        summary.lastIncorrectCount++
      }
    })
  })

  return {
    ...summary,
    openCount: summary.totalQuestions - summary.answeredCount,
    percent: summary.totalQuestions === 0 ? 0 : Math.round((summary.answeredCount / summary.totalQuestions) * 100),
  }
}

// Gruppiert die Katalog-States nach Lernabschnitt (aufsteigend nach Nummer).
export function groupBySection(states) {
  const sections = new Map()

  states.filter(isCatalogState).forEach((state) => {
    if (!sections.has(state.learningSectionId)) {
      sections.set(state.learningSectionId, [])
    }

    sections.get(state.learningSectionId).push(state)
  })

  return [...sections.entries()]
    .sort(([left], [right]) => compareSectionIds(left, right))
    .map(([sectionId, libraries]) => ({
      sectionId,
      label: sectionLabel(sectionId),
      libraries: libraries.sort((a, b) => a.libraryId.localeCompare(b.libraryId)),
    }))
}

// ---------------------------------------------------------------------------
// Batch-Planung (rein): Entscheidung, welche Dateien eines Mehrfach-Imports überhaupt in
// Frage kommen. Es wird nichts geschrieben; jede Datei bekommt ein nachvollziehbares Ergebnis.

export const BATCH_STATUS = {
  NEW: 'new',
  KNOWN: 'known',
  VERSION_UPDATED: 'versionUpdated',
  UPDATE_PENDING: 'updatePending',
  REPLACEMENT_PENDING: 'replacementPending',
  UPDATE_BLOCKED: 'updateBlocked',
  INVALID: 'invalid',
  REJECTED: 'rejected',
  SKIPPED: 'skipped',
}

export const BATCH_REASON = {
  BATCH_CONFLICT: 'batch-conflict',
  IDENTICAL_DUPLICATE: 'identical-duplicate',
  SUPERSEDED: 'superseded-version',
  DUPLICATE_QUESTION_IDS: 'duplicate-question-ids',
  SECTION_CHANGED: 'section-changed',
  NOT_A_LIBRARY: 'not-a-library',
  MULTIPLE_RETIRED_INDEXES: 'multiple-retired-indexes',
}

const byFileName = (a, b) => a.fileName.localeCompare(b.fileName)

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

// Gleiche Question-ID in mehreren Libraries: alle beteiligten Libraries werden blockiert
// (keine stille Überschreibung, keine zufällige Gewinner-Wahl).
export function findDuplicateQuestionIds(libraryEntries, storedStates = []) {
  const owners = new Map()
  const claim = (id, libraryId) => {
    if (!owners.has(id)) {
      owners.set(id, new Set())
    }

    owners.get(id).add(libraryId)
  }

  storedStates
    .filter((state) => isCatalogState(state))
    .forEach((state) => activeQuestionIdsOf(state).forEach((id) => claim(id, state.libraryId)))
  libraryEntries.forEach((entry) => Object.keys(entry.library.questionRevisions).forEach((id) => claim(id, entry.library.libraryId)))

  const clashes = new Map()

  owners.forEach((libraryIds, id) => {
    if (libraryIds.size > 1) {
      libraryIds.forEach((libraryId) => {
        if (!clashes.has(libraryId)) {
          clashes.set(libraryId, { ids: [], libraries: new Set() })
        }

        clashes.get(libraryId).ids.push(id)
        libraryIds.forEach((other) => other !== libraryId && clashes.get(libraryId).libraries.add(other))
      })
    }
  })

  return clashes
}

export function planLibraryBatch(entries, storedStates = []) {
  const results = []
  const candidates = []

  entries.forEach((entry) => {
    if (entry.kind === 'invalid') {
      results.push(resultFor(entry, BATCH_STATUS.INVALID, { message: entry.error }))
    } else if (entry.kind === 'v2') {
      candidates.push(entry)
    } else if (entry.kind === 'retiredIndex') {
      // Wird vom Aufrufer vor den Libraries verarbeitet; hier nur nicht als Library behandeln.
    } else {
      results.push(
        resultFor(entry, BATCH_STATUS.SKIPPED, {
          reason: BATCH_REASON.NOT_A_LIBRARY,
          message: msg('batch.notLibrary'),
        }),
      )
    }
  })

  // 1. Gleiche libraryId mehrfach im Batch: deterministisch entscheiden oder Konflikt melden.
  const byLibraryId = new Map()

  candidates.sort(byFileName).forEach((entry) => {
    const id = entry.library.libraryId

    byLibraryId.set(id, [...(byLibraryId.get(id) ?? []), entry])
  })

  const accepted = []

  byLibraryId.forEach((group, libraryId) => {
    if (group.length === 1) {
      accepted.push(group[0])
      return
    }

    const sameVersionDifferentHash = group.some((entry) =>
      group.some(
        (other) =>
          compareVersions(entry.library.libraryVersion, other.library.libraryVersion) === 0 &&
          entry.library.activeQuestionIndexHash !== other.library.activeQuestionIndexHash,
      ),
    )

    if (sameVersionDifferentHash) {
      group.forEach((entry) =>
        results.push(
          resultFor(entry, BATCH_STATUS.REJECTED, {
            reason: BATCH_REASON.BATCH_CONFLICT,
            message: msg('batch.conflict', { count: group.length }),
          }),
        ),
      )
      return
    }

    // Höchste Version gewinnt; bei gleicher Version (gleicher Hash) gewinnt die erste Datei nach Dateiname.
    const winner = group.reduce((best, entry) =>
      compareVersions(entry.library.libraryVersion, best.library.libraryVersion) > 0 ? entry : best,
    )

    accepted.push(winner)
    group
      .filter((entry) => entry !== winner)
      .forEach((entry) => {
        const identical = compareVersions(entry.library.libraryVersion, winner.library.libraryVersion) === 0

        results.push(
          resultFor(entry, BATCH_STATUS.SKIPPED, {
            reason: identical ? BATCH_REASON.IDENTICAL_DUPLICATE : BATCH_REASON.SUPERSEDED,
            message: identical
              ? msg('batch.identicalDuplicate', { libraryId, version: entry.library.libraryVersion, winner: winner.fileName })
              : msg('batch.superseded', {
                  version: entry.library.libraryVersion,
                  winnerVersion: winner.library.libraryVersion,
                  winner: winner.fileName,
                }),
          }),
        )
      })
  })

  // 2. Dieselbe aktive Question-ID in mehreren Libraries (im Batch oder bereits gespeichert).
  const clashes = findDuplicateQuestionIds(accepted, storedStates)
  const importable = []

  accepted.forEach((entry) => {
    const clash = clashes.get(entry.library.libraryId)

    if (!clash) {
      importable.push(entry)
      return
    }

    results.push(
      resultFor(entry, BATCH_STATUS.REJECTED, {
        reason: BATCH_REASON.DUPLICATE_QUESTION_IDS,
        conflictingLibraryIds: [...clash.libraries].sort(),
        message: msg('result.rejectedSuffix', {
          message: msg('reject.duplicateIds', { count: clash.ids.length, libraries: [...clash.libraries].sort().join(', ') }),
        }),
      }),
    )
  })

  return { importable: importable.sort((a, b) => a.library.libraryId.localeCompare(b.library.libraryId)), results }
}

export function summarizeBatch(entries, importable) {
  const recognized = entries.filter((entry) => entry.kind === 'v2')
  const libraryIds = new Set(recognized.map((entry) => entry.library.libraryId))
  // Je libraryId zählt die gewählte (gewinnende) Datei; ohne Gewinner (Konflikt) die höchste Version.
  const chosen = new Map(importable.map((entry) => [entry.library.libraryId, entry]))

  libraryIds.forEach((libraryId) => {
    if (!chosen.has(libraryId)) {
      const group = recognized.filter((entry) => entry.library.libraryId === libraryId)

      chosen.set(
        libraryId,
        group.reduce((best, entry) =>
          compareVersions(entry.library.libraryVersion, best.library.libraryVersion) > 0 ? entry : best,
        ),
      )
    }
  })

  return {
    filesChecked: entries.length,
    librariesRecognized: libraryIds.size,
    sectionsRecognized: new Set([...chosen.values()].map((entry) => entry.library.learningSectionId)).size,
    activeQuestions: [...chosen.values()].reduce((total, entry) => total + entry.library.questionCount, 0),
  }
}
