// Darstellungsmodell des Prüfungsmodus (Phase 3C). Rein, keine IO.
//
// Die UI-Komponenten bekommen ausschließlich dieses Modell, nie den gespeicherten Versuch: der enthält die Snapshots
// mit Lösung, Erklärung und Merkhilfe. Felder werden einzeln übernommen (Allowlist), nicht gefiltert. Während der
// Prüfung (`inProgress`) gibt es weder Ergebnis noch Korrektheitsangaben; das Ergebnis erscheint erst bei `submitted`
// und stammt unverändert aus `attempt.result` (keine UI-eigene Wertung).

import { EXAM_STATUS, presentExamQuestion, summarizeExamAttempt } from './examAttempt.js'

export function buildExamView(attempt) {
  const submitted = attempt.status === EXAM_STATUS.SUBMITTED
  const { questionCount, answeredCount, unansweredCount } = summarizeExamAttempt(attempt)
  const { result } = attempt

  return {
    examSessionId: attempt.examSessionId,
    status: attempt.status,
    language: attempt.sessionLanguage,
    questionCount,
    currentIndex: attempt.currentIndex,
    answeredCount,
    unansweredCount,
    firstUnansweredIndex: attempt.orderedQuestionIds.findIndex((id) => !(id in attempt.answers)),
    question: submitted ? null : presentExamQuestion(attempt, attempt.currentQuestionId),
    result: submitted
      ? {
          total: result.total,
          correct: result.correct,
          incorrect: result.incorrect,
          unanswered: result.unanswered,
          percent: result.percent,
        }
      : null,
  }
}
