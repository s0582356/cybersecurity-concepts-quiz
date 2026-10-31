// Replacement-Migration (Phase 2D): retired Question-IDs, inherit/reset, Merge.
//
// Grundlage: SECURITY_LIBRARY_PERSISTENCE_CONTRACT.md §2 Regel 4, §2a; ID-Standard (Tombstones).
//
// - `replacedBy` beschreibt nur die Nachfolger-Beziehung; ob Fortschritt übertragen wird,
//   entscheidet allein `progressMigration` (`inherit` | `reset`, kein Default).
// - `inherit` ist nur mit `learningGoalEquivalence: "confirmed"` zulässig und überträgt
//   ausschließlich portablen Fortschritt (Klasse A). Klasse B (gewählter optionKey/optionId,
//   UI-Auswahl, Optionsreihenfolge) wird nie übertragen; es gibt kein Option-Mapping.
// - `reset` überträgt nichts.
// - Die Merge-Funktion bei Fortschritt auf Retire- UND Keep-ID ist laut Contract eine
//   App-Regel; sie ist unten feldweise festgelegt.

import { msg, translate } from '../i18n/index.js'

const QUESTION_ID_PATTERN = /^sec-a\d{2}-\d{4}$/
const POLICIES = ['inherit', 'reset']
// Der Contract verbietet Klasse-B-/Mapping-Felder im Index (Validator: Fehler).
const FORBIDDEN_ENTRY_FIELDS = [
  'selectedOptionKey',
  'selectedOptionId',
  'optionKey',
  'optionId',
  'optionMapping',
  'optionMap',
]

export class RetiredIndexError extends Error {
  // `issueItems`: dieselben Befunde als übersetzbare Meldungen (Phase 2F); `issues` bleibt die deutsche Standardfassung.
  constructor(issues, issueItems = []) {
    super(`Ungültiger Ersetzungs-Index: ${issues.slice(0, 3).join('; ')}${issues.length > 3 ? ' …' : ''}`)
    this.name = 'RetiredIndexError'
    this.issues = issues
    this.issueItems = issueItems
  }
}

export class MigrationError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'MigrationError'
    this.code = code
  }
}

// Strenge Prüfung: bei jedem Fehler wird der gesamte Index abgelehnt (keine stille Teil-Semantik).
// Der Freitext `reason` wird nicht übernommen (wird zur Laufzeit nicht gebraucht).
export function parseRetiredIndex(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new RetiredIndexError([translate('de', 'retired.notObject')], [msg('retired.notObject')])
  }

  const issues = []
  const issueItems = []
  const addIssue = (key, params) => {
    issues.push(translate('de', key, params))
    issueItems.push(msg(key, params))
  }
  const entries = {}

  Object.entries(data).forEach(([id, entry]) => {
    if (!QUESTION_ID_PATTERN.test(id)) {
      addIssue('retired.invalidId', { id })
      return
    }

    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      addIssue('retired.entryNotObject', { id })
      return
    }

    if (typeof entry.replacedBy !== 'string' || !QUESTION_ID_PATTERN.test(entry.replacedBy)) {
      addIssue('retired.replacedBy', { id })
      return
    }

    if (entry.replacedBy === id) {
      addIssue('retired.selfCycle', { id })
      return
    }

    if (!POLICIES.includes(entry.progressMigration)) {
      addIssue('retired.policy', { id })
      return
    }

    if (entry.progressMigration === 'inherit' && entry.learningGoalEquivalence !== 'confirmed') {
      addIssue('retired.inheritEquivalence', { id })
      return
    }

    const forbidden = FORBIDDEN_ENTRY_FIELDS.filter((field) => field in entry)

    if (forbidden.length > 0) {
      addIssue('retired.forbidden', { id, fields: forbidden.join(', ') })
      return
    }

    entries[id] = {
      replacedBy: entry.replacedBy,
      progressMigration: entry.progressMigration,
      ...(entry.progressMigration === 'inherit' && { learningGoalEquivalence: 'confirmed' }),
    }
  })

  // Keine Ketten und keine Zyklen: das Ziel darf nicht selbst retired sein.
  Object.entries(entries).forEach(([id, entry]) => {
    if (entry.replacedBy in entries) {
      const cycle = entries[entry.replacedBy].replacedBy === id
      addIssue('retired.chain', { id, target: entry.replacedBy, kind: msg(cycle ? 'retired.kind.cycle' : 'retired.kind.chain') })
    }
  })

  if (issues.length > 0) {
    throw new RetiredIndexError(issues, issueItems)
  }

  return entries
}

// Welche entfernten Fragen erklärt der Index vollständig? Ziel muss aktiv in der neuen Library
// oder in einer anderen bekannten Library sein; eine retired-ID darf nirgends aktiv sein.
export function planReplacements({ removedIds, retiredIndex, library, otherStates }) {
  const replacements = []
  const unexplained = []
  const problems = []
  const owner = (id) => otherStates.find((state) => state.questionRevisions && id in state.questionRevisions)

  ;[...removedIds].sort().forEach((from) => {
    const entry = retiredIndex?.[from]

    if (!entry) {
      unexplained.push({ id: from, reason: 'noTombstone' })
      return
    }

    if (owner(from)) {
      problems.push({ id: from, reason: 'activeAndRetired' })
      return
    }

    let targetLibraryId = null

    if (library.questionRevisions && entry.replacedBy in library.questionRevisions) {
      targetLibraryId = library.libraryId
    } else {
      targetLibraryId = owner(entry.replacedBy)?.libraryId ?? null
    }

    if (!targetLibraryId) {
      unexplained.push({ id: from, reason: 'targetUnknown' })
      return
    }

    replacements.push({
      from,
      to: entry.replacedBy,
      policy: entry.progressMigration,
      targetLibraryId,
    })
  })

  return { replacements, unexplained, problems }
}

function validateRecord(record, label) {
  const counters = [record.attempts, record.correctCount, record.incorrectCount]

  if (
    !counters.every((value) => Number.isInteger(value) && value >= 0) ||
    record.attempts !== record.correctCount + record.incorrectCount ||
    ![null, undefined, 'correct', 'incorrect'].includes(record.lastResult)
  ) {
    throw new MigrationError('corruptProgress', `Fortschrittsdatensatz (${label}) ist inkonsistent.`)
  }
}

// Merge-Regeln pro Feld (Source = Retire-ID, Target = Keep-ID). Jeder Versuch ist ein eigenes
// Ereignis genau einer Frage; die Source wird danach als „consumed“ markiert, damit kein
// Versuch ein zweites Mal einfließt.
//   attempts / correctCount / incorrectCount  Summe (disjunkte Ereignisse; Invariante attempts = correct + incorrect)
//   answered                                  ODER (zählt je Keep-Frage einmal, nie doppelt)
//   lastAnsweredAt                            Maximum
//   lastResult                                Ergebnis des jüngsten Versuchs (lastAnsweredAt); bei Gleichstand das der Keep-ID
//   answeredAtRevision                        nur behalten, wenn der jüngste Versuch der eigene der Keep-ID ist
//                                             (Revisionsnummern gehören zu genau einer Frage und werden nicht übertragen)
//   Error-Training / Mastery                  abgeleitet aus lastResult/Zählern, nichts gespeichert
//   selectedOptionKey / optionId / UI-State   nie (Klasse B; die Keep-Antwort bleibt unverändert)
export function mergePortableProgress(target, source, sourceKey, targetKey) {
  const sourceIsNewer = (source.lastAnsweredAt ?? 0) > (target?.lastAnsweredAt ?? -1)
  const latest = !target || sourceIsNewer ? source : target
  const inheritedFrom = [
    ...(target?.inheritedFrom ?? []),
    { libraryId: sourceKey.libraryId, questionId: sourceKey.questionId },
  ]

  return {
    libraryId: targetKey.libraryId,
    questionId: targetKey.questionId,
    attempts: (target?.attempts ?? 0) + source.attempts,
    correctCount: (target?.correctCount ?? 0) + source.correctCount,
    incorrectCount: (target?.incorrectCount ?? 0) + source.incorrectCount,
    lastResult: latest.lastResult ?? null,
    answered: Boolean(target?.answered || source.answered),
    lastAnsweredAt: Math.max(target?.lastAnsweredAt ?? 0, source.lastAnsweredAt ?? 0),
    ...(latest === target && target?.answeredAtRevision != null && {
      answeredAtRevision: target.answeredAtRevision,
    }),
    inheritedFrom,
  }
}

// Wendet genau eine Ersetzung auf die Fortschrittsdatensätze an. Rein und idempotent:
// eine bereits konsumierte Source führt zu `alreadyMigrated` ohne Änderung.
export function applyReplacementToProgress({ source, target, policy, sourceKey, targetKey, now }) {
  if (!source) {
    return { outcome: 'noSource' }
  }

  if (source.historical || source.migratedTo) {
    return { outcome: 'alreadyMigrated' }
  }

  if (!POLICIES.includes(policy)) {
    throw new MigrationError('unknownPolicy', `Unbekannte progressMigration "${policy}".`)
  }

  validateRecord(source, 'Quelle')

  if (target) {
    validateRecord(target, 'Ziel')
  }

  // Die Quelle bleibt als historischer Datensatz erhalten, zählt aber nicht mehr als aktiv.
  const consumed = {
    ...source,
    historical: true,
    migratedTo: {
      libraryId: targetKey.libraryId,
      questionId: targetKey.questionId,
      policy,
      appliedAt: now,
    },
  }

  if (policy === 'reset') {
    return { outcome: 'reset', source: consumed }
  }

  return { outcome: 'inherited', source: consumed, target: mergePortableProgress(target, source, sourceKey, targetKey) }
}
