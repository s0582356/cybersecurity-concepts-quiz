// Fragenpool und Start des Prüfungsmodus (Phase 3B).
//
// Wie in sectionService: `read*` lädt Rohdaten aus dem Store, `build*` leitet daraus rein ab. Der Pool besteht aus
// den aktiven Fragen aller katalogisierten Libraries – es werden keine Fragen kopiert und keine IDs erzeugt.
// Nach dem Start liest der Versuch nie wieder aus den Libraries (Snapshot im Versuchsdatensatz).

import { isCatalogState } from '../domain/libraryCatalog.js'
import { createExamAttempt } from '../domain/examAttempt.js'
import { normalizeStoredQuestion } from '../domain/questionContent.js'

export async function readExamPoolData(store) {
  const states = (await store.listLibraryStates()).filter(isCatalogState)
  const contents = await Promise.all(states.map((state) => store.getLibraryContent(state.libraryId)))

  return { states, contents }
}

// Libraries, deren gespeicherter Inhalt nicht zum Library-State passt, werden nie still verwendet (wie buildSectionView).
export function buildExamPool({ states, contents }) {
  const pool = []
  const excludedLibraryIds = []

  states.forEach((state, index) => {
    const content = contents[index]

    if (!content || content.activeQuestionIndexHash !== state.activeQuestionIndexHash) {
      excludedLibraryIds.push(state.libraryId)
      return
    }

    content.questions
      .map(normalizeStoredQuestion)
      .filter((question) => question.id in state.questionRevisions)
      .forEach((question) => pool.push({ question, libraryId: state.libraryId, sectionId: state.learningSectionId }))
  })

  return { pool, libraries: states.filter((state) => !excludedLibraryIds.includes(state.libraryId)), excludedLibraryIds }
}

export async function readExamPool(store) {
  return buildExamPool(await readExamPoolData(store))
}

// Pool lesen, Versuch erzeugen und speichern. Rückgabe wie `startExamAttempt`; Fehler der Auswahl (Pool zu klein,
// ungültige Anzahl/Sprache) kommen als ExamError.
export async function startExam(store, { language = 'de', preset = null, count = null, random = Math.random, now = Date.now() } = {}) {
  const { pool, libraries } = await readExamPool(store)
  const attempt = createExamAttempt({ pool, libraries, language, preset, count, random, now })

  return store.startExamAttempt(attempt)
}
