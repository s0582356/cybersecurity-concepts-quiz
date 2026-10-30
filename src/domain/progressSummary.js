// Leitet Anzeige-Statistiken aus den gespeicherten Rohdaten ab.
// Es werden keine abgeleiteten Werte persistiert; nur Fortschritt zu Fragen,
// die in der aktuell geladenen Library aktiv sind, wird gezählt.

export function summarizeLibraryProgress(questions, progressRecords) {
  const progressByQuestionId = new Map(
    progressRecords.map((record) => [record.questionId, record]),
  )
  const categories = new Map()
  const summary = {
    totalQuestions: questions.length,
    answeredCount: 0,
    lastCorrectCount: 0,
    lastIncorrectCount: 0,
    totalAttempts: 0,
    categories: [],
  }

  questions.forEach((question) => {
    const name = question.category || 'Allgemein'
    const progress = progressByQuestionId.get(question.id)

    if (!categories.has(name)) {
      categories.set(name, { name, total: 0, answered: 0, lastCorrect: 0 })
    }

    const category = categories.get(name)
    category.total++

    if (!progress?.answered) {
      return
    }

    summary.answeredCount++
    summary.totalAttempts += progress.attempts
    category.answered++

    if (progress.lastResult === 'correct') {
      summary.lastCorrectCount++
      category.lastCorrect++
    } else {
      summary.lastIncorrectCount++
    }
  })

  summary.categories = [...categories.values()].sort((a, b) => a.name.localeCompare(b.name))

  return summary
}
