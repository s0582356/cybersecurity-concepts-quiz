// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { createApp, nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../src/App.vue'
import { createProgressStore } from '../src/storage/progressStore.js'
import { makeSyntheticLibrary, V1_QUESTIONS } from './fixtures/syntheticLibrary.js'

let mounted = []

function mountApp() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp(App)
  app.mount(container)
  mounted.push({ app, container })
  return { app, container }
}

function unmountApp(entry) {
  entry.app.unmount()
  entry.container.remove()
  mounted = mounted.filter((item) => item !== entry)
}

async function importJson(container, data, fileName = 'test.json') {
  const input = container.querySelector('input[type="file"]')
  const file = { name: fileName, text: async () => JSON.stringify(data) }

  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  input.dispatchEvent(new Event('change'))
  await vi.waitFor(() => expect(container.querySelector('.start-card button.start-button')).not.toBeNull())
  await settle()
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 30))
  await nextTick()
}

function buttonByText(container, text) {
  return [...container.querySelectorAll('button')].find((button) => button.textContent.trim() === text)
}

function answerButtons(container) {
  return [...container.querySelectorAll('.answer-button')]
}

async function answerCurrent(container, answers, { correct }) {
  const heading = container.querySelector('.question-card h2').textContent
  const expected = answers.get(heading)
  const button = answerButtons(container).find((candidate) => {
    const isRight = candidate.textContent.trim() === expected
    return correct ? isRight : !isRight
  })

  button.click()
  await nextTick()
}

function answerMap(library) {
  return new Map(
    library.questions.map((question) => [
      question.localized.de.question,
      question.localized.de.optionText[question.correctOptionKey],
    ]),
  )
}

async function startQuiz(container) {
  buttonByText(container, 'Mit aktueller Fragebank starten').click()
  await nextTick()
}

beforeEach(() => {
  window.alert = vi.fn()
  // Jede Testfunktion beginnt mit frischem Browser-Speicher.
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
    expect(container.querySelector('.question-card h2').textContent).toBe('V1 Frage eins?')

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

describe('V2 persistence in the app', () => {
  const library = makeSyntheticLibrary({ libraryId: 'app-test-library', count: 4 })

  it('persists answers and survives a reload', async () => {
    const first = mountApp()
    await importJson(first.container, library, 'v2.json')

    expect(first.container.querySelector('.library-message').textContent).toContain('Neue Bibliothek')
    await startQuiz(first.container)

    const answers = answerMap(library)
    await answerCurrent(first.container, answers, { correct: true })
    buttonByText(first.container, 'Nächste Frage').click()
    await nextTick()
    await answerCurrent(first.container, answers, { correct: false })
    await settle()

    unmountApp(first)

    // Reload: neue App-Instanz, Datei wird erneut geladen
    const second = mountApp()
    await importJson(second.container, library, 'v2.json')

    expect(second.container.querySelector('.library-message').textContent).toContain('Bekannte Bibliothek')
    const summary = second.container.querySelector('[aria-label="Gespeicherter Fortschritt"]')
    expect(summary.textContent).toContain('Beantwortet: 2 von 4')
    expect(summary.textContent).toContain('zuletzt richtig: 1')
    expect(summary.textContent).toContain('zuletzt falsch: 1')
    expect(summary.textContent).toContain('Versuche gesamt: 2')

    const store = createProgressStore({ dbName: 'cybersecurity-concepts-quiz' })
    await store.initialize()
    const records = await store.listProgressForLibrary('app-test-library')
    store.close()

    expect(records.map((record) => record.questionId)).toEqual(['sec-a30-0001', 'sec-a30-0002'])
    expect(records.map((record) => record.lastResult)).toEqual(['correct', 'incorrect'])

    // Weitere Antwort nach dem Reload addiert auf den gespeicherten Stand
    await startQuiz(second.container)
    await answerCurrent(second.container, answers, { correct: true })
    await settle()
    const verify = createProgressStore({ dbName: 'cybersecurity-concepts-quiz' })
    await verify.initialize()
    expect((await verify.getQuestionProgress('app-test-library', 'sec-a30-0001')).attempts).toBe(2)
    verify.close()
  })

  it('stops a changed-hash import without touching stored progress', async () => {
    const first = mountApp()
    await importJson(first.container, library)
    await startQuiz(first.container)
    await answerCurrent(first.container, answerMap(library), { correct: true })
    await settle()
    unmountApp(first)

    const changed = makeSyntheticLibrary({
      libraryId: 'app-test-library',
      count: 4,
      activeQuestionIndexHash: `sha256:${'c'.repeat(64)}`,
    })
    const second = mountApp()
    const input = second.container.querySelector('input[type="file"]')
    Object.defineProperty(input, 'files', {
      value: [{ name: 'changed.json', text: async () => JSON.stringify(changed) }],
      configurable: true,
    })
    input.dispatchEvent(new Event('change'))
    await vi.waitFor(() => expect(second.container.querySelector('.library-message-error')).not.toBeNull())

    expect(second.container.querySelector('.library-message-error').textContent).toContain(
      'nicht geladen',
    )
    expect(second.container.querySelector('.question-bank-label').textContent).not.toContain('changed.json')

    const store = createProgressStore({ dbName: 'cybersecurity-concepts-quiz' })
    await store.initialize()
    expect(await store.listProgressForLibrary('app-test-library')).toHaveLength(1)
    expect((await store.getLibraryState('app-test-library')).activeQuestionIndexHash).toBe(
      library.activeQuestionIndexHash,
    )
    store.close()
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
      await answerCurrent(container, answerMap(library), { correct: true })
      expect(container.querySelector('.feedback-correct')).not.toBeNull()
    } finally {
      globalThis.indexedDB = original
    }
  })
})
