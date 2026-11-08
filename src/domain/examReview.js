// Ergebnis-Review des Prüfungsmodus (Phase 3D). Rein, keine IO.
//
// Das Review liest ausschließlich den gespeicherten, abgegebenen Versuch: Frage, Optionen, Lösung, Erklärung und
// Merkhilfe stammen aus `questionSnapshots`, die Optionsreihenfolge aus `optionOrder`, die Antwort aus `answers`.
// Aktuelle Library-Daten spielen keine Rolle (Updates, Revisionen, Ersetzungen und Entfernen ändern ein Review nie).
// Fehlt etwas oder passt der Datensatz nicht zur Phase-3B-Validierung, gibt es KEIN Review (keine Reparatur, kein
// Ausweichen auf aktuelle Inhalte). Das Review rechnet das Ergebnis nicht neu: die Zusammenfassung bleibt `attempt.result`.

import { EXAM_STATUS, validateExamAttempt } from './examAttempt.js'

export const REVIEW_STATUS = { CORRECT: 'correct', INCORRECT: 'incorrect', UNANSWERED: 'unanswered' }

export const REVIEW_PROBLEM = { INVALID: 'invalid', NOT_SUBMITTED: 'notSubmitted' }

// Status einer Frage allein aus gespeicherter Antwort und Snapshot-Lösung (nie über Anzeigeposition).
function statusOf(selectedKey, correctKey) {
  if (selectedKey === null) {
    return REVIEW_STATUS.UNANSWERED
  }

  return selectedKey === correctKey ? REVIEW_STATUS.CORRECT : REVIEW_STATUS.INCORRECT
}

// Rückgabe: { ok: true, review } oder { ok: false, reason }. Ein laufender Versuch bekommt nie ein Review
// (Lösungen und Erklärungen dürfen erst nach der Abgabe sichtbar werden).
export function buildExamReview(attempt) {
  if (!validateExamAttempt(attempt).valid) {
    return { ok: false, reason: REVIEW_PROBLEM.INVALID }
  }

  if (attempt.status !== EXAM_STATUS.SUBMITTED) {
    return { ok: false, reason: REVIEW_PROBLEM.NOT_SUBMITTED }
  }

  const items = attempt.orderedQuestionIds.map((id, index) => {
    const snapshot = attempt.questionSnapshots[id]
    const { content, correctOptionKey } = snapshot
    const selectedKey = attempt.answers[id] ?? null

    return {
      id,
      index,
      sectionId: snapshot.sectionId,
      text: content.question,
      options: attempt.optionOrder[id].map((key) => ({
        key,
        text: content.optionText[key],
        selected: key === selectedKey,
        correct: key === correctOptionKey,
      })),
      selectedKey,
      correctKey: correctOptionKey,
      status: statusOf(selectedKey, correctOptionKey),
      explanation: content.explanation,
      memoryAid: content.memoryAid ? { type: content.memoryAid.type ?? null, text: content.memoryAid.text } : null,
    }
  })

  return {
    ok: true,
    review: {
      examSessionId: attempt.examSessionId,
      language: attempt.sessionLanguage,
      questionCount: items.length,
      items,
    },
  }
}

// "Letztes Ergebnis": der abgegebene Versuch mit dem jüngsten gültigen `completedAt`. Bei Gleichstand entscheidet
// der spätere Start (`sessionStartedAt`), danach die größere `examSessionId` – deterministisch, nie zufällig.
// Ob der Datensatz vollständig gültig ist, prüft erst das Laden (beschädigte Ergebnisse werden nicht übersprungen,
// sonst erschiene ein älteres Ergebnis fälschlich als "letztes").
export function pickLastExamResult(attempts) {
  const finite = (value) => (Number.isFinite(value) ? value : -Infinity)
  const candidates = attempts.filter(
    (attempt) =>
      attempt?.status === EXAM_STATUS.SUBMITTED && typeof attempt.examSessionId === 'string' && Number.isFinite(attempt.completedAt),
  )

  candidates.sort(
    (left, right) =>
      right.completedAt - left.completedAt ||
      finite(right.sessionStartedAt) - finite(left.sessionStartedAt) ||
      (left.examSessionId < right.examSessionId ? 1 : left.examSessionId > right.examSessionId ? -1 : 0),
  )

  return candidates.length === 0 ? null : { examSessionId: candidates[0].examSessionId, completedAt: candidates[0].completedAt }
}
