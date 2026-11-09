// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  answerButtons,
  buttonByText,
  chooseLanguageOption,
  heading,
  importFiles,
  mountApp,
  next,
  openSection,
  reloadWithoutImport,
  resetBrowserStorage,
  resume,
  scoreText,
  sectionCard,
  settle,
  startQuiz,
  switchLanguage,
  unmountAll,
  withStore,
} from './helpers/appHarness.js'
import { loadLanguagePreference } from '../src/i18n/index.js'
import { makeSyntheticLibrary } from './fixtures/syntheticLibrary.js'

beforeEach(() => {
  resetBrowserStorage()
  loadLanguagePreference()
})
afterEach(unmountAll)

const hash = (char) => `sha256:${char.repeat(64)}`
const lib = (libraryId, prefix, options = {}) =>
  makeSyntheticLibrary({
    libraryId,
    idPrefix: prefix,
    questionLabel: `${libraryId} Frage`,
    count: 3,
    activeQuestionIndexHash: hash(libraryId.length.toString(16).slice(-1)),
    ...options,
  })
const file = (data) => ({ name: `${data.libraryId}.json`, data })

// Beantwortet die aktuelle Frage in der gerade angezeigten Sprache; gibt ID und Sprache zurück.
async function answer(container, libraries, { correct }) {
  const all = libraries.flatMap((data) => data.questions)
  const shown = heading(container)
  const question = all.find((item) => item.localized.de.question === shown || item.localized.en?.question === shown)
  const language = question.localized.de.question === shown ? 'de' : 'en'
  const expected = question.localized[language].optionText[question.correctOptionKey]

  answerButtons(container).find((button) => (button.textContent.trim() === expected) === correct).click()
  await nextTick()

  return { id: question.id, language, question }
}

const GERMAN_UI_WORDS = ['Lernabschnitt', 'beantwortet', 'Bibliothek', 'Lernrunde', 'Nächste Frage', 'Fortschritt', 'Fragen', 'Quiz bereit']

describe('UI language', () => {
  it('defaults to German and the document language follows the UI language', async () => {
    const { container } = mountApp()

    await settle()
    expect(container.textContent).toContain('Noch keine Lernbibliotheken importiert.')
    expect(container.querySelector('.import-button').textContent.trim()).toBe('JSON-Bibliotheken auswählen')
    expect(container.querySelector('.language-button-active').textContent.trim()).toBe('DE')
    expect(document.documentElement.getAttribute('lang')).toBe('de')
  })

  it('switches the whole main UI to English without leftover German UI texts', async () => {
    const { container } = mountApp()

    await settle()
    await switchLanguage(container, 'en')

    const text = container.textContent

    expect(text).toContain('No learning libraries imported yet.')
    expect(text).toContain('Select JSON libraries')
    expect(text).toContain('Train important security fundamentals')
    expect(text).toContain('Quiz ready')
    expect(text).toContain('Start with current question bank')
    expect(text).toContain('Project information'.length ? 'GitHub' : '')
    expect(container.querySelector('.footer, .app-footer').getAttribute('aria-label')).toBe('Project information')
    expect(document.documentElement.getAttribute('lang')).toBe('en')
    GERMAN_UI_WORDS.forEach((word) => expect(text, word).not.toContain(word))
  })

  it('keeps the chosen language after a reload', async () => {
    const first = mountApp()

    await settle()
    await switchLanguage(first.container, 'en')

    const second = await reloadWithoutImport(first)

    await settle()
    expect(second.container.textContent).toContain('Select JSON libraries')
    expect(second.container.querySelector('.language-button-active').textContent.trim()).toBe('EN')
  })

  it('import result, overview and statuses are English, and switching back translates the existing report', async () => {
    const { container } = mountApp()

    await settle()
    await switchLanguage(container, 'en')
    await importFiles(container, [
      file(lib('lib-a', 'sec-a01')),
      file(lib('lib-b', 'sec-a51', { count: 2 })),
      { name: 'kaputt.json', raw: '{ not json' },
      { name: 'wrong.json', raw: JSON.stringify({ schemaVersion: '2.0.0', libraryId: 'x' }) },
    ])

    const report = container.querySelector('.import-report').textContent

    expect(report).toContain('4 files checked · 2 libraries recognised · 1 learning section · 5 active questions')
    expect(report).toContain('Newly imported')
    expect(report).toContain('Invalid')
    expect(report).toContain('The file is not valid JSON')
    expect(report).toContain('V2 library: "libraryId" is missing or invalid.')
    GERMAN_UI_WORDS.forEach((word) => expect(report, word).not.toContain(word))

    const card = sectionCard(container, 'Learning section 99').textContent.replace(/\s+/g, ' ')

    expect(card).toContain('2 libraries')
    expect(card).toContain('5 questions')
    expect(card).toContain('0 answered · 5 open')
    expect(card).toContain('Resume: No')
    expect(card).toContain('Learn')

    await switchLanguage(container, 'de')
    const german = container.querySelector('.import-report').textContent

    expect(german).toContain('4 Dateien geprüft · 2 Libraries erkannt')
    expect(german).toContain('Neu importiert')
    expect(german).toContain('V2-Library: "libraryId" fehlt oder ist ungültig.')
    expect(sectionCard(container, 'Lernabschnitt 99').textContent).toContain('5 Fragen')
  })

  it('error and update messages are English: duplicate IDs, pending update, confirmation', async () => {
    const app = mountApp()

    await settle()
    await switchLanguage(app.container, 'en')
    await importFiles(app.container, [file(lib('lib-one', 'sec-a01'))])
    await importFiles(app.container, [file(lib('lib-clash', 'sec-a01', { learningSectionId: 'la05' }))])

    expect(app.container.querySelector('.library-message-error').textContent).toContain('Rejected')
    expect(app.container.querySelector('.library-message-error').textContent).toContain('also active in lib-one')
    expect(app.container.querySelector('.library-message-error').textContent).toContain('nothing was overwritten')

    await importFiles(app.container, [file(lib('lib-one', 'sec-a01', { count: 4, libraryVersion: '1.1.0', activeQuestionIndexHash: hash('9') }))])

    const message = app.container.querySelector('.library-message-error').textContent

    expect(message).toContain('Update needs confirmation')
    expect(message).toContain('1 questions are new')
    expect(message).toContain('The file has not been loaded yet.')
    GERMAN_UI_WORDS.forEach((word) => expect(message, word).not.toContain(word))

    buttonByText(app.container, 'Apply update').click()
    await vi.waitFor(() => expect(app.container.querySelector('.import-report').textContent).toContain('Library updated to version 1.1.0'))
  })

  it('learning view, feedback, result screen are English; without English content a round needs an explicit German choice', async () => {
    const data = lib('lib-g', 'sec-a30', { count: 2 })
    const app = mountApp()

    await settle()
    await switchLanguage(app.container, 'en')
    await importFiles(app.container, [file(data)])
    await openSection(app.container, 'Learning section 99')
    expect(app.container.textContent).toContain('Learning round ready')

    // "Nur Englisch" ohne englische Fragen: kontrolliert blockiert, nichts gestartet, nichts gespeichert.
    expect(app.container.querySelector('.language-preview').textContent).toContain('no English questions for this learning section yet (0 of 2)')
    buttonByText(app.container, 'Start learning round').click()
    await settle()
    expect(app.container.querySelector('.library-message-error').textContent).toContain('no English questions')
    expect(await withStore((store) => store.getLatestSectionSession('la99'))).toBeNull()

    // UI bleibt Englisch, Inhalt bewusst Deutsch (UI-Sprache und Inhaltssprache sind getrennt).
    await chooseLanguageOption(app.container, 'de')
    await startQuiz(app.container)

    expect(scoreText(app.container)).toContain('Question 1 of 2')
    expect(scoreText(app.container)).toContain('Score: 0')
    expect(heading(app.container)).toMatch(/^lib-g Frage 000\d\?$/)
    expect(app.container.querySelector('.language-note')).toBeNull()

    await answer(app.container, [data], { correct: true })
    expect(app.container.querySelector('.feedback-correct').textContent.trim()).toBe('Correct.')
    expect(buttonByText(app.container, 'Next question')).toBeDefined()
    await next(app.container)
    await answer(app.container, [data], { correct: false })
    expect(app.container.querySelector('.feedback-wrong').textContent).toContain('Not quite. The correct answer is:')
    buttonByText(app.container, 'Show results').click()
    await nextTick()

    const result = app.container.textContent

    expect(result).toContain('Quiz completed')
    expect(result).toContain('Total questions')
    expect(result).toContain('Correct answers')
    expect(result).toContain('Repeat wrong questions')
    GERMAN_UI_WORDS.forEach((word) => expect(result, word).not.toContain(word))
  })

  it('the resume panel and a blocked round are English', async () => {
    const data = lib('lib-p', 'sec-a30', { count: 3 })
    const first = mountApp()

    await settle()
    await importFiles(first.container, [file(data)])
    await openSection(first.container, 'Lernabschnitt 99')
    await startQuiz(first.container)
    await answer(first.container, [data], { correct: true })
    await settle()

    const second = await reloadWithoutImport(first)

    await switchLanguage(second.container, 'en')
    await openSection(second.container, 'Learning section 99')
    expect(second.container.querySelector('[aria-label="Learning round"]').textContent).toContain(
      'Question 1 of 3 · 1 answered · 1 correct · 0 wrong · 2 open',
    )
    expect(buttonByText(second.container, 'Continue learning round')).toBeDefined()
    expect(sectionCard(second.container, 'Learning section 99').textContent).toContain('Continue')

    const stored = await withStore((store) => store.getLatestSectionSession('la99'))

    await withStore((store) =>
      store.startNewSession({ ...stored, orderedQuestionIds: [...stored.orderedQuestionIds, 'sec-a30-0099'], questionLibraries: { ...stored.questionLibraries, 'sec-a30-0099': 'lib-p' }, questionRevisions: { ...stored.questionRevisions, 'sec-a30-0099': 1 } }),
    )
    const third = await reloadWithoutImport(second)

    await openSection(third.container, 'Learning section 99')

    const panel = third.container.querySelector('[aria-label="Learning round"]').textContent

    expect(panel).toContain('Learning round cannot be continued')
    expect(panel).toContain('(1 missing)')
    expect(panel).toContain('Discard round and start over')
  })
})

describe('content language (bilingual synthetic library)', () => {
  const data = lib('lib-bi', 'sec-a30', { count: 4, english: 'all' })

  async function started(language = 'de') {
    const app = mountApp()

    await settle()

    if (language === 'en') {
      await switchLanguage(app.container, 'en')
    }

    await importFiles(app.container, [file(data)])
    await openSection(app.container, language === 'en' ? 'Learning section 99' : 'Lernabschnitt 99')
    await startQuiz(app.container)

    return app
  }

  const snapshot = () =>
    withStore(async (store) => ({
      session: await store.getLatestSectionSession('la99'),
      progress: await store.listAllProgress(),
      state: await store.getLibraryState('lib-bi'),
    }))

  it('English preference with complete coverage shows English questions, options, explanation and memory aid', async () => {
    const app = await started('en')
    const shown = await answer(app.container, [data], { correct: false })

    expect(shown.language).toBe('en')
    expect(app.container.querySelector('.language-note')).toBeNull()
    expect(app.container.querySelector('.explanation').textContent.trim()).toMatch(/^Synthetic explanation/)
    expect(app.container.querySelector('.memory-aid').textContent).toContain('Memory aid: Synthetic memory aid')
  })

  it('German preference shows the German version of the same question (baseline)', async () => {
    const app = await started('de')
    const shown = await answer(app.container, [data], { correct: true })

    expect(shown.language).toBe('de')
    expect(app.container.querySelector('.explanation').textContent.trim()).toMatch(/^Synthetische Erklärung/)
    expect(app.container.querySelector('.memory-aid').textContent).toContain('Merkhilfe: Synthetisch.')
  })

  // Der einzige erlaubte Schreibvorgang beim Sprachwechsel: das Sprachfeld der Runde (Contract: Resume-Sprache).
  const withoutSessionLanguage = (snap) => ({ ...snap, session: { ...snap.session, sessionLanguage: undefined } })

  it('switching DE → EN mid-round keeps question, position, option keys, round and storage untouched', async () => {
    const app = await started('de')
    const before = await (async () => { await settle(); return snapshot() })()
    const shown = await answer(app.container, [data], { correct: true })

    await next(app.container)
    const second = (await answer(app.container, [data], { correct: false })).question
    await next(app.container)

    const questionId = (await (async () => { await settle(); return snapshot() })()).session.currentQuestionId
    const germanOrder = answerButtons(app.container).map((button) => button.textContent.trim())
    const beforeSwitch = await snapshot()

    await switchLanguage(app.container, 'en')

    const source = data.questions.find((question) => question.id === questionId)
    const englishOrder = answerButtons(app.container).map((button) => button.textContent.trim())

    expect(heading(app.container)).toBe(source.localized.en.question)
    // gleiche Schlüsselreihenfolge: Position i trägt in beiden Sprachen denselben Optionsschlüssel
    const keyOf = (language, text) => Object.entries(source.localized[language].optionText).find(([, value]) => value === text)[0]

    expect(englishOrder.map((text) => keyOf('en', text))).toEqual(germanOrder.map((text) => keyOf('de', text)))
    expect(scoreText(app.container)).toContain('Question 3 of 4')
    expect(scoreText(app.container)).toContain('Score: 1')
    expect(scoreText(app.container)).toContain('Current streak: 0')
    expect(scoreText(app.container)).toContain('Best streak: 1')
    // Nur Darstellung: keine einzige Schreiboperation durch den Sprachwechsel.
    await settle()

    const afterSwitch = await snapshot()

    expect(afterSwitch.session.sessionLanguage).toBe('en')
    expect(withoutSessionLanguage(afterSwitch)).toEqual(withoutSessionLanguage(beforeSwitch))
    expect(before.session.orderedQuestionIds).toEqual(beforeSwitch.session.orderedQuestionIds)
    expect(shown.id).toBeTruthy()
    expect(second.id).toBeTruthy()
  })

  it('an answered question keeps its selection, rating and counters; only the explanation language changes', async () => {
    const app = await started('de')
    const { id, question } = await answer(app.container, [data], { correct: false })
    const selectedIndex = answerButtons(app.container).findIndex((button) => button.classList.contains('answer-wrong'))
    const correctIndex = answerButtons(app.container).findIndex((button) => button.classList.contains('answer-correct'))

    await settle()

    const before = await snapshot()

    await switchLanguage(app.container, 'en')

    expect(app.container.querySelector('.feedback-wrong')).not.toBeNull()
    expect(answerButtons(app.container).findIndex((button) => button.classList.contains('answer-wrong'))).toBe(selectedIndex)
    expect(answerButtons(app.container).findIndex((button) => button.classList.contains('answer-correct'))).toBe(correctIndex)
    expect(answerButtons(app.container).every((button) => button.disabled)).toBe(true)
    expect(app.container.querySelector('.explanation').textContent.trim()).toBe(question.localized.en.explanation)
    expect(app.container.querySelector('.feedback-wrong strong').textContent).toBe(
      question.localized.en.optionText[question.correctOptionKey],
    )

    // erneutes Klicken zählt nicht; kein zweiter Fortschritt, attempts bleibt 1
    answerButtons(app.container)[0].click()
    await settle()

    const after = await snapshot()

    expect(withoutSessionLanguage(after)).toEqual(withoutSessionLanguage(before))
    expect(after.progress.filter((record) => record.questionId === id)).toHaveLength(1)
    expect(after.progress[0]).toMatchObject({ attempts: 1, incorrectCount: 1, correctCount: 0 })
    expect(scoreText(app.container)).toContain('Score: 0')
  })

  it('EN → DE works the same way and the same progress record is used', async () => {
    const app = await started('en')
    const { id } = await answer(app.container, [data], { correct: true })

    await settle()
    await switchLanguage(app.container, 'de')
    expect(app.container.querySelector('.feedback-correct').textContent.trim()).toBe('Richtig.')
    expect(app.container.querySelector('.explanation').textContent).toContain('Synthetische Erklärung')
    await next(app.container)
    await answer(app.container, [data], { correct: true })
    await settle()

    const progress = await withStore((store) => store.listAllProgress())

    expect(progress).toHaveLength(2)
    expect(progress.every((record) => record.libraryId === 'lib-bi' && record.attempts === 1)).toBe(true)
    expect(progress.some((record) => record.questionId === id)).toBe(true)
    expect(scoreText(app.container)).toContain('Aktuelle Serie: 2')
  })

  it('reload after a language switch keeps English and resumes the exact same question', async () => {
    const first = await started('de')

    await answer(first.container, [data], { correct: true })
    await next(first.container)
    await switchLanguage(first.container, 'en')
    await settle()

    const before = await snapshot()
    const second = await reloadWithoutImport(first)

    await openSection(second.container, 'Learning section 99')
    expect(second.container.querySelector('[aria-label="Learning round"]').textContent).toContain('Question 2 of 4')
    await resume(second.container)

    const source = data.questions.find((question) => question.id === before.session.currentQuestionId)

    expect(heading(second.container)).toBe(source.localized.en.question)
    expect(scoreText(second.container)).toContain('Question 2 of 4')
    expect(scoreText(second.container)).toContain('Score: 1')
    expect((await snapshot()).session.orderedQuestionIds).toEqual(before.session.orderedQuestionIds)

    // zurück auf Deutsch: gleiche Frage, Fortschritt unverändert
    await switchLanguage(second.container, 'de')
    expect(heading(second.container)).toBe(source.localized.de.question)
    await settle()
    expect((await snapshot()).progress).toEqual(before.progress)
  })

  it('library version and hash stay untouched by a language switch (no update migration)', async () => {
    const app = await started('de')

    await settle()

    const before = await snapshot()

    await switchLanguage(app.container, 'en')
    await switchLanguage(app.container, 'de')
    await settle()
    expect((await snapshot()).state).toEqual(before.state)
    expect(app.container.querySelector('.library-message-error')).toBeNull()
  })

  it('shows the language availability on the section card', async () => {
    const app = mountApp()

    await settle()
    await importFiles(app.container, [file(data)])
    expect(sectionCard(app.container, 'Lernabschnitt 99').textContent).toContain('Deutsch · English')
  })
})
