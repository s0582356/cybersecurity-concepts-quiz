// Lesen/Ableiten der Katalog- und Lernabschnitts-Daten (Phase 2E).
//
// `read*` lädt Rohdaten aus dem Store, `build*` leitet daraus rein ab. So lässt sich dieselbe
// Ableitung auch für einen flüchtigen Katalog ohne Speicher verwenden (Speicher nicht verfügbar).

import {
  groupBySection,
  isCatalogState,
  sectionActiveQuestions,
  summarizeSectionProgress,
} from '../domain/libraryCatalog.js'
import { summarizeLibraryProgress } from '../domain/progressSummary.js'
import { SESSION_STATUS } from '../domain/session.js'
import { evaluateSectionSession } from '../domain/sectionSession.js'
import { coverageOf, normalizeStoredQuestion } from '../domain/questionContent.js'
import { msg } from '../i18n/index.js'

export async function readCatalogData(store) {
  const [states, progress, sessions] = await Promise.all([
    store.listLibraryStates(),
    store.listAllProgress(),
    store.listSectionSessions(),
  ])

  return { states, progress, sessions }
}

const newestFirst = (a, b) => b.sessionStartedAt - a.sessionStartedAt

export function buildOverview({ states, progress, sessions }) {
  const sections = groupBySection(states).map((section) => {
    const summary = summarizeSectionProgress(section.libraries, progress)
    const session = sessions.filter((candidate) => candidate.sectionId === section.sectionId).sort(newestFirst)[0]
    const evaluation = evaluateSectionSession(session ?? null, sectionActiveQuestions(states, section.sectionId))

    // Englisch ist nur verfügbar, wenn jede aktive Frage jeder Library gültiges Englisch hat (Zähler aus dem Katalog).
    const englishCount = section.libraries.reduce((total, state) => total + (state.contentCoverage?.en ?? 0), 0)
    const englishComplete = summary.totalQuestions > 0 && section.libraries.every((state) => (state.contentCoverage?.en ?? 0) === state.questionCount)

    return {
      sectionId: section.sectionId,
      label: section.label,
      englishCount,
      englishComplete,
      libraryCount: section.libraries.length,
      questionCount: summary.totalQuestions,
      answeredCount: summary.answeredCount,
      openCount: summary.openCount,
      percent: summary.percent,
      hasResume: evaluation.status === SESSION_STATUS.RESUMABLE,
      sessionStatus: evaluation.status,
    }
  })

  return {
    sections,
    // Zustände aus Phase ≤ 2D kennen weder Abschnitt noch Fragen: sie erscheinen erst nach erneutem Import.
    uncatalogedLibraryIds: states.filter((state) => !isCatalogState(state)).map((state) => state.libraryId),
  }
}

export async function readSectionData(store, sectionId) {
  const states = (await store.listLibraryStates()).filter(
    (state) => isCatalogState(state) && state.learningSectionId === sectionId,
  )
  const [contents, progress, session] = await Promise.all([
    Promise.all(states.map((state) => store.getLibraryContent(state.libraryId))),
    store.listAllProgress(),
    store.getLatestSectionSession(sectionId),
  ])

  return { sectionId, states, contents, progress, session }
}

// Fragen eines Abschnitts aus den gespeicherten Inhalten; unvollständige/abweichende Inhalte werden gemeldet.
export function buildSectionView({ sectionId, states, contents, progress, session }) {
  const label = groupBySection(states)[0]?.label ?? sectionId
  const libraries = [...states].sort((a, b) => a.libraryId.localeCompare(b.libraryId))
  const contentOf = (state) => contents[states.indexOf(state)]
  const problems = libraries.filter((state) => {
    const content = contentOf(state)

    return !content || content.activeQuestionIndexHash !== state.activeQuestionIndexHash
  })

  if (libraries.length === 0 || problems.length > 0) {
    return {
      sectionId,
      label,
      libraries,
      error: msg(libraries.length === 0 ? 'section.missing' : 'section.contentMismatch'),
    }
  }

  // Fragen aus Phase 2E enthalten nur die flache deutsche Ansicht; sie werden beim Lesen ergänzt.
  const questions = libraries.flatMap((state) => contentOf(state).questions).map(normalizeStoredQuestion)
  const keys = new Set(questions.map((question) => `${question.libraryId}::${question.id}`))
  const records = progress.filter((record) => keys.has(`${record.libraryId}::${record.questionId}`))

  return {
    sectionId,
    label,
    libraries,
    questions,
    coverage: coverageOf(questions),
    summary: summarizeLibraryProgress(questions, records),
    evaluation: evaluateSectionSession(session ?? null, questions),
  }
}
