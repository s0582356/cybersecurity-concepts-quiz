// Klassifikation von Library-Updates (Phase 2C).
//
// Grundlage: Persistence Contract §2 (Regeln 2, 3, 5, 9) und §4 (Reconciliation-Ablauf).
// - gleiche ID, höhere contentRevision: Fortschritt bleibt (Regel 5)
// - neue IDs: starten ohne Fortschritt (Regel 3)
// - fehlende IDs: brauchen den retired-index (Regel 4) – nicht Teil von Phase 2C
// - gleiche Version, aber anderer Hash / starke Abweichung: Nutzer entscheidet (Regel 9)
//
// Der activeQuestionIndexHash umfasst {id, status, contentRevision}; ein Hash-Wechsel
// bedeutet daher immer eine Änderung der aktiven Fragenlandschaft.

import { planReplacements } from './replacementMigration.js'

export const CHANGE_KIND = {
  REVISIONS_ONLY: 'revisionsOnly',
  QUESTIONS_REPLACED: 'questionsReplaced',
  QUESTIONS_ADDED: 'questionsAdded',
  QUESTIONS_REMOVED: 'questionsRemoved',
  REVISIONS_LOWERED: 'revisionsLowered',
  UNEXPECTED_HASH_CHANGE: 'unexpectedHashChange',
  UNKNOWN_BASELINE: 'unknownBaseline',
}

// Nur diese Änderungen lassen sich ohne retired-index und ohne Replacement-Logik übernehmen.
const COMPATIBLE_KINDS = new Set([
  CHANGE_KIND.REVISIONS_ONLY,
  CHANGE_KIND.QUESTIONS_ADDED,
  CHANGE_KIND.QUESTIONS_REPLACED,
])

export function compareVersions(left, right) {
  const leftParts = left.split('.').map(Number)
  const rightParts = right.split('.').map(Number)

  for (let index = 0; index < 3; index++) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] > rightParts[index] ? 1 : -1
    }
  }

  return 0
}

export function diffRevisions(baseline, current) {
  const change = { added: [], removed: [], revised: [], lowered: [] }

  Object.keys(current).forEach((id) => {
    if (!(id in baseline)) {
      change.added.push(id)
    } else if (current[id] > baseline[id]) {
      change.revised.push(id)
    } else if (current[id] < baseline[id]) {
      change.lowered.push(id)
    }
  })
  Object.keys(baseline).forEach((id) => {
    if (!(id in current)) {
      change.removed.push(id)
    }
  })

  return change
}

// Voraussetzung: known.activeQuestionIndexHash !== library.activeQuestionIndexHash
export function classifyHashChange(known, library, { retiredIndex = null, otherStates = [] } = {}) {
  const versionRelation = compareVersions(library.libraryVersion, known.libraryVersion)
  const result = (changeKind, change = null, extra = {}) => ({
    changeKind,
    change,
    versionRelation,
    compatible: COMPATIBLE_KINDS.has(changeKind),
    ...extra,
  })

  // Ohne gespeicherten Revisionsstand (Zustand aus Phase 2A/2B) lässt sich nichts sicher vergleichen.
  if (!known.questionRevisions) {
    return result(CHANGE_KIND.UNKNOWN_BASELINE)
  }

  const change = diffRevisions(known.questionRevisions, library.questionRevisions)

  // Version nicht erhöht, aber Fragenlandschaft anders: starke, unerwartete Abweichung (Regel 9).
  if (versionRelation <= 0) {
    return result(CHANGE_KIND.UNEXPECTED_HASH_CHANGE, change)
  }

  if (change.lowered.length > 0) {
    return result(CHANGE_KIND.REVISIONS_LOWERED, change)
  }

  if (change.removed.length > 0) {
    // Entfernte Fragen sind nur übernehmbar, wenn der Ersetzungs-Index sie vollständig erklärt.
    const plan = planReplacements({ removedIds: change.removed, retiredIndex, library, otherStates })
    const explained = plan.unexplained.length === 0 && plan.problems.length === 0

    return result(explained ? CHANGE_KIND.QUESTIONS_REPLACED : CHANGE_KIND.QUESTIONS_REMOVED, change, plan)
  }

  if (change.added.length === 0 && change.revised.length === 0) {
    // Hash weicht ab, obwohl IDs und Revisionen gleich sind: Datei nicht vertrauenswürdig.
    return result(CHANGE_KIND.UNEXPECTED_HASH_CHANGE, change)
  }

  return result(change.added.length > 0 ? CHANGE_KIND.QUESTIONS_ADDED : CHANGE_KIND.REVISIONS_ONLY, change)
}
