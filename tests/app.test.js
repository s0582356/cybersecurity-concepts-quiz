// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { createApp, nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../src/App.vue'
import { createProgressStore } from '../src/storage/progressStore.js'
import { makeSyntheticLibrary, V1_QUESTIONS } from './fixtures/syntheticLibrary.js'

const DB_NAME = 'cybersecurity-concepts-quiz'
let mounted = []

function mountApp() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp(App)
  app.mount(container)
  const entry = { app, container }
  mounted.push(entry)
  return entry
}

function unmountApp(entry) {
  entry.app.unmount()
  entry.container.remove()
  mounted = mounted.filter((item) => item !== entry)
}

async function settle(ms = 60) {
  await new Promise((resolve) => setTimeout(resolve, ms))
  await nextTick()
}

async function importJson(container, data, fileName = 'test.json') {
  const input = container.querySelector('input[type="file"]')
  const file = { name: fileName, text: async () => JSON.stringify(data) }

  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  input.dispatchEvent(new Event('change'))
  await vi.waitFor(() => {
    const label = container.querySelector('.question-bank-label').textContent
    expect(label.includes(fileName) || container.querySelector('.library-message-error')).toBeTruthy()
  })
  await settle()
}

function buttonByText(container, text) {
  return [...container.querySelectorAll('button')].find((button) => button.textContent.trim() === text)
}

function answerButtons(container) {
  return [...container.querySelectorAll('.answer-button')]
}

function optionTexts(container) {
  return answerButtons(container).map((button) => button.textContent.trim())
}

function heading(container) {
  return container.querySelector('.question-card h2')?.textContent ?? null
}

function scoreText(container) {
  return container.querySelector('.score-card')?.textContent.replace(/\s+/g, ' ').trim()
}

async function startQuiz(container) {
  buttonByText(container, 'Mit aktueller Fragebank starten').click()
  await vi.waitFor(() => expect(heading(container)).not.toBeNull())
}

async function resume(container) {
  buttonByText(container, 'Lernrunde fortsetzen').click()
  await vi.waitFor(() => expect(heading(container)).not.toBeNull())
}

// Beantwortet die aktuelle Frage und gibt ihre Question-ID zurück.
async function answerCurrent(container, library, { correct }) {
  const source = library.questions.find((question) => question.localized.de.question === heading(container))
  const expected = source.localized.de.optionText[source.correctOptionKey]
  const button = answerButtons(container).find((candidate) => (candidate.textContent.trim() === expected) === correct)

  button.click()
  await nextTick()
  return source.id
}

async function next(container) {
  buttonByText(container, 'Nächste Frage').click()
  await nextTick()
}

// Reload = alte App-Instanz weg, neue App-Instanz, Library-Datei wird erneut geladen.
async function reload(entry, library, fileName = 'v2.json') {
  await settle()
  unmountApp(entry)
  const fresh = mountApp()
  await importJson(fresh.container, library, fileName)
  return fresh
}

async function withStore(callback) {
  const store = createProgressStore({ dbName: DB_NAME })
  await store.initialize()

  try {
    return await callback(store)
  } finally {
    store.close()
  }
}

beforeEach(() => {
  window.alert = vi.fn()
  // Jeder Test beginnt mit frischem Browser-Speicher.
  globalThis.indexedDB = new (globalThis.indexedDB.constructor)()
})

afterEach(() => {
  mounted.slice().forEach(unmountApp)
})

describe('V1 regression', () => {
  it('imports a V1 bank, starts the quiz and runs the answer flow', async () => {
    const { container } = mountApp()
    await importJson(container, V1_QUESTIONS, 'v1.json')

    expect(container.querySelector('.question-bank-label').textContent).toContain('v1.json')
    expect(container.querySelector('.library-message')).toBeNull()
    expect(container.textContent).not.toContain('Gespeicherter Fortschritt')

    await startQuiz(container)
    expect(heading(container)).toBe('V1 Frage eins?')

    const options = answerButtons(container)
    expect(options.map((button) => button.textContent.trim()).sort()).toEqual(
      ['V1 falsch A', 'V1 falsch B', 'V1 richtig'].sort(),
    )

    options.find((button) => button.textContent.trim() === 'V1 richtig').click()
    await nextTick()

    expect(container.querySelector('.feedback-correct')).not.toBeNull()
    expect(container.textContent).toContain('V1 Erklärung eins.')

    buttonByText(container, 'Nächste Frage').click()
    await nextTick()
    answerButtons(container).find((button) => button.textContent.trim() === 'V1 zwei falsch').click()
    await nextTick()
    expect(container.querySelector('.feedback-wrong')).not.toBeNull()

    buttonByText(container, 'Auswertung anzeigen').click()
    await nextTick()

    expect(container.textContent).toContain('Auswertung')
    expect(container.textContent).toContain('V1 Kategorie')
    expect(buttonByText(container, 'Falsche Fragen wiederholen')).toBeDefined()
  })

  it('does not write anything to IndexedDB for V1 banks', async () => {
    const { container } = mountApp()
    await importJson(container, V1_QUESTIONS)
    await startQuiz(container)
    answerButtons(container)[0].click()
    await settle()

    const databases = await indexedDB.databases()
    expect(databases).toEqual([])
  })
})

describe('V2 resume in the app', () => {
  const library = makeSyntheticLibrary({ libraryId: 'app-test-library', count: 4 })
  const textById = new Map(library.questions.map((question) => [question.id, question.localized.de.question]))

  it('starts a persisted session with a stored question order of stable IDs', async () => {
    const app = mountApp()
    await importJson(app.container, library)
    await startQuiz(app.container)
    await settle()

    const session = await withStore((store) => store.getLatestSession('app-test-library'))

    expect([...session.orderedQuestionIds].sort()).toEqual(library.questions.map((question) => question.id))
    expect(session).toMatchObject({ currentIndex: 0, completed: false, sessionMode: 'learning' })
    expect(textById.get(session.currentQuestionId)).toBe(heading(app.container))
  })

  it('case A: reload before answering shows the same unanswered question and option order', async () => {
    const first = mountApp()
    await importJson(first.container, library)
    await startQuiz(first.container)
    const shownHeading = heading(first.container)
    const shownOptions = optionTexts(first.container)

    const second = await reload(first, library)

    expect(second.container.querySelector('[aria-label="Lernrunde"]').textContent).toContain('Frage 1 von 4')
    await resume(second.container)
    expect(heading(second.container)).toBe(shownHeading)
    expect(optionTexts(second.container)).toEqual(shownOptions)
    expect(second.container.querySelector('.feedback-box')).toBeNull()
    expect(scoreText(second.container)).toContain('Frage 1 von 4')
  })

  it('case B: reload after an answer (before "Weiter") restores the answered question without double counting', async () => {
    const first = mountApp()
    await importJson(first.container, library)
    await startQuiz(first.container)
    const shownHeading = heading(first.container)
    const questionId = await answerCurrent(first.container, library, { correct: false })
    await settle()

    const second = await reload(first, library)
    await resume(second.container)

    expect(heading(second.container)).toBe(shownHeading)
    expect(second.container.querySelector('.feedback-wrong')).not.toBeNull()
    expect(second.container.querySelectorAll('.answer-wrong')).toHaveLength(1)
    expect(second.container.querySelectorAll('.answer-correct')).toHaveLength(1)
    expect(answerButtons(second.container).every((button) => button.disabled)).toBe(true)
    expect(scoreText(second.container)).toContain('Frage 1 von 4')
    expect(scoreText(second.container)).toContain('Score: 0')

    // Nochmal klicken zählt nicht (Frage ist beantwortet) – weder Session noch Lebenszeit-Progress.
    answerButtons(second.container)[0].click()
    await settle()

    const { progress, session } = await withStore(async (store) => ({
      progress: await store.getQuestionProgress('app-test-library', questionId),
      session: await store.getLatestSession('app-test-library'),
    }))

    expect(progress).toMatchObject({ attempts: 1, incorrectCount: 1 })
    expect(session).toMatchObject({ answeredQuestionIds: [questionId], sessionIncorrectCount: 1, currentQuestionId: questionId })
  })

  it('case C: "Weiter" persists the next question; repeated reloads keep the order', async () => {
    let app = mountApp()
    await importJson(app.container, library)
    await startQuiz(app.container)
    const order = (await (async () => { await settle(); return withStore((store) => store.getLatestSession('app-test-library')) })()).orderedQuestionIds

    await answerCurrent(app.container, library, { correct: true })
    await next(app.container)
    const secondHeading = heading(app.container)
    expect(secondHeading).toBe(textById.get(order[1]))

    for (let round = 0; round < 3; round++) {
      app = await reload(app, library)
      await resume(app.container)
      expect(heading(app.container)).toBe(secondHeading)
      expect(scoreText(app.container)).toContain('Frage 2 von 4')
      expect(app.container.querySelector('.feedback-box')).toBeNull()
    }

    const session = await withStore((store) => store.getLatestSession('app-test-library'))

    expect(session).toMatchObject({ orderedQuestionIds: order, currentQuestionId: order[1], currentIndex: 1 })
  })

  it('keeps score, streak and categories across a reload and finishes without double counting', async () => {
    const first = mountApp()
    await importJson(first.container, library)
    await startQuiz(first.container)
    await answerCurrent(first.container, library, { correct: true })
    await next(first.container)
    await answerCurrent(first.container, library, { correct: false })
    await next(first.container)
    await settle()

    const second = await reload(first, library)
    expect(second.container.querySelector('[aria-label="Lernrunde"]').textContent).toContain(
      '2 beantwortet · 1 richtig · 1 falsch · 2 offen',
    )
    await resume(second.container)

    expect(scoreText(second.container)).toContain('Frage 3 von 4')
    expect(scoreText(second.container)).toContain('Score: 1')
    expect(scoreText(second.container)).toContain('Aktuelle Serie: 0')
    expect(scoreText(second.container)).toContain('Beste Serie: 1')

    await answerCurrent(second.container, library, { correct: true })
    await next(second.container)
    await answerCurrent(second.container, library, { correct: true })
    buttonByText(second.container, 'Auswertung anzeigen').click()
    await nextTick()

    const values = [...second.container.querySelectorAll('.result-grid strong')].map((node) => node.textContent)

    expect(values).toEqual(['4', '3', '1', '75%', '2'])
    const categoryTotals = [...second.container.querySelectorAll('.category-card p')].map((node) => node.textContent)
    const sum = categoryTotals.reduce((total, text) => total + Number(text.match(/\/(\d+)/)[1]), 0)

    expect(sum).toBe(4)
    expect(buttonByText(second.container, 'Falsche Fragen wiederholen')).toBeDefined()
  })

  it('marks a finished round completed, offers a new round and keeps lifetime progress', async () => {
    const first = mountApp()
    await importJson(first.container, library)
    await startQuiz(first.container)
    const oldSession = await withStore((store) => store.getLatestSession('app-test-library'))

    for (let index = 0; index < 4; index++) {
      await answerCurrent(first.container, library, { correct: index !== 1 })

      if (index < 3) {
        await next(first.container)
      }
    }

    buttonByText(first.container, 'Auswertung anzeigen').click()
    await nextTick()

    // Wiederholung falscher Fragen zählt im Lebenszeit-Progress, ändert die abgeschlossene Runde nicht.
    buttonByText(first.container, 'Falsche Fragen wiederholen').click()
    await nextTick()
    const reviewedId = await answerCurrent(first.container, library, { correct: true })
    await settle()

    const second = await reload(first, library)
    const panel = second.container.querySelector('[aria-label="Lernrunde"]')

    expect(panel.textContent).toContain('Lernrunde abgeschlossen')
    expect(panel.textContent).toContain('3 richtig, 1 falsch von 4 Fragen')
    expect(buttonByText(second.container, 'Lernrunde fortsetzen')).toBeUndefined()
    expect(second.container.querySelector('[aria-label="Gespeicherter Fortschritt"]').textContent).toContain(
      'Beantwortet: 4 von 4',
    )

    const completed = await withStore((store) => store.getLatestSession('app-test-library'))

    expect(completed).toMatchObject({ sessionId: oldSession.sessionId, completed: true, sessionCorrectCount: 3, sessionIncorrectCount: 1 })

    buttonByText(second.container, 'Neue Runde starten').click()
    await vi.waitFor(() => expect(heading(second.container)).not.toBeNull())
    await settle()

    const fresh = await withStore((store) => store.getLatestSession('app-test-library'))
    const lifetime = await withStore((store) => store.listProgressForLibrary('app-test-library'))

    expect(fresh.sessionId).not.toBe(oldSession.sessionId)
    expect(fresh).toMatchObject({ completed: false, answeredQuestionIds: [], sessionCorrectCount: 0, currentIndex: 0 })
    expect(lifetime).toHaveLength(4)
    expect(lifetime.find((record) => record.questionId === reviewedId).attempts).toBe(2)
    expect(scoreText(second.container)).toContain('Score: 0')
  })

  it('does not resume a session against a changed question landscape (hash) and keeps it stored', async () => {
    const first = mountApp()
    await importJson(first.container, library)
    await startQuiz(first.container)
    await answerCurrent(first.container, library, { correct: true })
    await settle()
    const before = await withStore((store) => store.getLatestSession('app-test-library'))
    unmountApp(first)

    const changed = makeSyntheticLibrary({
      libraryId: 'app-test-library',
      count: 4,
      activeQuestionIndexHash: `sha256:${'c'.repeat(64)}`,
    })
    const second = mountApp()
    await importJson(second.container, changed, 'changed.json')

    expect(second.container.querySelector('.library-message-error').textContent).toContain('nicht geladen')
    expect(buttonByText(second.container, 'Lernrunde fortsetzen')).toBeUndefined()
    expect(await withStore((store) => store.getLatestSession('app-test-library'))).toEqual(before)

    // Mit der ursprünglichen Datei lässt sich die Runde weiterhin fortsetzen.
    const third = await reload(second, library)
    await resume(third.container)
    expect(scoreText(third.container)).toContain('Score: 1')
  })

  it('blocks resume with a controlled state if stored question IDs are missing in the library', async () => {
    const first = mountApp()
    await importJson(first.container, library)
    await startQuiz(first.container)
    await settle()
    const before = await withStore((store) => store.getLatestSession('app-test-library'))
    unmountApp(first)

    // Gleiche Metadaten/Hash, aber eine Frage weniger: Landschaft passt nicht zur gespeicherten Runde.
    const reduced = makeSyntheticLibrary({ libraryId: 'app-test-library', count: 3 })
    const second = mountApp()
    await importJson(second.container, reduced, 'reduced.json')

    const panel = second.container.querySelector('[aria-label="Lernrunde"]')

    expect(panel.textContent).toContain('Lernrunde kann nicht fortgesetzt werden')
    expect(panel.textContent).toContain('1 fehlen')
    expect(buttonByText(second.container, 'Lernrunde fortsetzen')).toBeUndefined()
    expect(await withStore((store) => store.getLatestSession('app-test-library'))).toEqual(before)
  })

  it('keeps sessions of different libraries separate', async () => {
    const other = makeSyntheticLibrary({ libraryId: 'other-test-library', count: 4 })
    const first = mountApp()
    await importJson(first.container, library)
    await startQuiz(first.container)
    await settle()

    const second = await reload(first, other, 'other.json')

    expect(second.container.querySelector('[aria-label="Lernrunde"]')).toBeNull()
    await startQuiz(second.container)
    await settle()

    const sessions = await withStore(async (store) => ({
      one: await store.getLatestSession('app-test-library'),
      two: await store.getLatestSession('other-test-library'),
    }))

    expect(sessions.one.sessionId).not.toBe(sessions.two.sessionId)
    expect(sessions.one.libraryId).toBe('app-test-library')
    expect(sessions.two.libraryId).toBe('other-test-library')
  })

  it('keeps lifetime progress separate from the round: a discarded round does not erase it', async () => {
    const first = mountApp()
    await importJson(first.container, library)
    await startQuiz(first.container)
    const questionId = await answerCurrent(first.container, library, { correct: true })
    await settle()

    const second = await reload(first, library)
    buttonByText(second.container, 'Aktuelle Runde verwerfen und neu starten').click()
    await vi.waitFor(() => expect(heading(second.container)).not.toBeNull())
    await settle()

    const { progress, session } = await withStore(async (store) => ({
      progress: await store.getQuestionProgress('app-test-library', questionId),
      session: await store.getLatestSession('app-test-library'),
    }))

    expect(progress).toMatchObject({ attempts: 1, correctCount: 1 })
    expect(session.answeredQuestionIds).toEqual([])
    expect(scoreText(second.container)).toContain('Score: 0')
  })

  it('persists lifetime answers across a reload and shows them on the start screen', async () => {
    const first = mountApp()
    await importJson(first.container, library)
    await startQuiz(first.container)
    await answerCurrent(first.container, library, { correct: true })
    await next(first.container)
    await answerCurrent(first.container, library, { correct: false })
    await settle()

    const second = await reload(first, library)
    const summary = second.container.querySelector('[aria-label="Gespeicherter Fortschritt"]')

    expect(second.container.querySelector('.library-message').textContent).toContain('Bekannte Bibliothek')
    expect(summary.textContent).toContain('Beantwortet: 2 von 4')
    expect(summary.textContent).toContain('zuletzt richtig: 1')
    expect(summary.textContent).toContain('zuletzt falsch: 1')
    expect(summary.textContent).toContain('Versuche gesamt: 2')
  })

  it('shows a warning but keeps the quiz usable when storage is unavailable', async () => {
    const original = globalThis.indexedDB
    globalThis.indexedDB = undefined

    try {
      const { container } = mountApp()
      await importJson(container, library)

      expect(container.querySelector('.library-message-warning').textContent).toContain(
        'Fortschritt wird nicht gespeichert',
      )
      await startQuiz(container)
      await answerCurrent(container, library, { correct: true })
      expect(container.querySelector('.feedback-correct')).not.toBeNull()
    } finally {
      globalThis.indexedDB = original
    }
  })
})
