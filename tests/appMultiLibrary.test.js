// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  answerCurrent,
  buttonByText,
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
  sectionCards,
  settle,
  startQuiz,
  unmountAll,
  withStore,
} from './helpers/appHarness.js'
import { makeSyntheticLibrary, V1_QUESTIONS } from './fixtures/syntheticLibrary.js'

beforeEach(resetBrowserStorage)
afterEach(unmountAll)

const hash = (char) => `sha256:${char.repeat(64)}`
const lib = (libraryId, section, prefix, options = {}) =>
  makeSyntheticLibrary({
    libraryId,
    learningSectionId: section,
    idPrefix: prefix,
    questionLabel: `${libraryId} Frage`,
    count: 3,
    activeQuestionIndexHash: hash(libraryId.length.toString(16).slice(-1)),
    ...options,
  })
const file = (data, name) => ({ name: name ?? `${data.libraryId}.json`, data })

// Drei Sections: la01 (2 Libraries), la02 (1), la08 (2).
const LIBRARIES = [
  lib('lib-one-a', 'la01', 'sec-a01'),
  lib('lib-one-b', 'la01', 'sec-a51', { count: 2 }),
  lib('lib-two', 'la02', 'sec-a02'),
  lib('lib-eight-a', 'la08', 'sec-a08'),
  lib('lib-eight-b', 'la08', 'sec-a58', { count: 4 }),
]
const allFiles = () => LIBRARIES.map((data) => file(data))
const questionText = new Map(
  LIBRARIES.flatMap((data) => data.questions.map((question) => [question.id, question.localized.de.question])),
)

async function importAll() {
  const app = mountApp()

  await importFiles(app.container, allFiles())

  return app
}

describe('empty state', () => {
  it('asks for the libraries when nothing has been imported yet', async () => {
    const { container } = mountApp()

    await settle()
    expect(container.textContent).toContain('Noch keine Lernbibliotheken importiert.')
    expect(container.querySelector('.import-button').textContent.trim()).toBe('JSON-Bibliotheken auswählen')
    expect(sectionCards(container)).toHaveLength(0)
    expect(container.querySelector('input[type="file"]').hasAttribute('multiple')).toBe(true)
  })
})

describe('multi-file import and overview', () => {
  it('imports all libraries at once, shows a summary computed from the files and one card per learning section', async () => {
    const { container } = await importAll()

    expect(container.querySelector('.import-summary').textContent).toBe(
      '5 Dateien geprüft · 5 Libraries erkannt · 3 Lernabschnitte · 15 aktive Fragen',
    )
    expect(container.querySelectorAll('.import-results li')).toHaveLength(5)
    expect(sectionCards(container).map((card) => card.querySelector('h3').textContent)).toEqual([
      'Lernabschnitt 1',
      'Lernabschnitt 2',
      'Lernabschnitt 8',
    ])

    const eight = sectionCard(container, 'Lernabschnitt 8').textContent.replace(/\s+/g, ' ')

    expect(eight).toContain('2 Libraries')
    expect(eight).toContain('7 Fragen')
    expect(eight).toContain('0 beantwortet · 7 offen')
    expect(eight).toContain('0 %')
    expect(eight).toContain('Resume: Nein')
    expect(sectionCard(container, 'Lernabschnitt 2').textContent).toContain('1 Library')
    expect(container.querySelector('.import-button').textContent.trim()).toBe('Bibliotheken importieren')
  })

  it('reports an invalid file and a duplicate while the valid files are still imported', async () => {
    const app = mountApp()

    await importFiles(app.container, [
      file(LIBRARIES[0]),
      { name: 'kaputt.json', raw: '{ das ist kein json' },
      file(LIBRARIES[2]),
      file(LIBRARIES[2], 'lib-two-kopie.json'),
    ])

    const text = app.container.querySelector('.import-report').textContent

    expect(text).toContain('4 Dateien geprüft · 2 Libraries erkannt · 2 Lernabschnitte')
    expect(text).toContain('kaputt.json')
    expect(text).toContain('Ungültig')
    expect(text).toContain('lib-two-kopie.json')
    expect(text).toContain('Übersprungen')
    expect(app.container.querySelectorAll('.library-message-error').length).toBeGreaterThanOrEqual(2)
    expect(sectionCards(app.container)).toHaveLength(2)
  })

  it('does not show file names in the normal workflow once the libraries are stored', async () => {
    const first = await importAll()

    expect(first.container.textContent).toContain('lib-one-a.json')

    const second = await reloadWithoutImport(first)
    await vi.waitFor(() => expect(sectionCards(second.container)).toHaveLength(3))

    expect(second.container.textContent).not.toContain('.json"')
    expect(second.container.textContent).not.toContain('lib-one-a')
    expect(second.container.querySelector('.import-report')).toBeNull()
  })

  it('a V1 file together with others is reported as skipped; a single V1 file keeps the old behaviour', async () => {
    const app = mountApp()

    await importFiles(app.container, [file(LIBRARIES[2]), file(V1_QUESTIONS, 'v1.json')])
    expect(app.container.querySelector('.import-report').textContent).toContain('nur einzeln')
    expect(sectionCards(app.container)).toHaveLength(1)
  })
})

describe('learning a section with several libraries', () => {
  const allQuestions = { questions: LIBRARIES.flatMap((data) => data.questions) }
  const answer = (container, correct) => answerCurrent(container, allQuestions, { correct })

  async function learn(entry, label, answers) {
    const answered = []

    await openSection(entry.container, label)
    await startQuiz(entry.container)

    for (let index = 0; index < answers.length; index++) {
      answered.push(await answer(entry.container, answers[index]))

      if (index < answers.length - 1) {
        await next(entry.container)
      }
    }

    await settle()

    return answered
  }

  it('starts one round with the questions of all libraries of the section, with stable ids and a persisted order', async () => {
    const { container } = await importAll()

    await openSection(container, 'Lernabschnitt 8')
    await startQuiz(container)
    await settle()

    const session = await withStore((store) => store.getLatestSectionSession('la08'))
    const expectedIds = LIBRARIES.filter((data) => data.questions[0].learningSectionId === 'la08')
      .flatMap((data) => data.questions.map((question) => question.id))
      .sort()

    expect([...session.orderedQuestionIds].sort()).toEqual(expectedIds)
    expect(session.orderedQuestionIds.some((id) => id.startsWith('sec-a08'))).toBe(true)
    expect(session.orderedQuestionIds.some((id) => id.startsWith('sec-a58'))).toBe(true)
    expect(questionText.get(session.currentQuestionId)).toBe(heading(container))
    expect(scoreText(container)).toContain('Frage 1 von 7')
  })

  it('keeps answers per (libraryId, questionId) and shows the aggregated progress on the card after a reload', async () => {
    const first = await importAll()
    const answered = await learn(first, 'Lernabschnitt 8', [true, false, true])
    const progress = await withStore((store) => store.listAllProgress())

    expect(progress).toHaveLength(3)
    answered.forEach((id) => {
      const owner = id.startsWith('sec-a08') ? 'lib-eight-a' : 'lib-eight-b'

      expect(progress.find((record) => record.questionId === id)).toMatchObject({ libraryId: owner, attempts: 1 })
    })

    const second = await reloadWithoutImport(first)
    await vi.waitFor(() => expect(sectionCards(second.container)).toHaveLength(3))

    const eight = sectionCard(second.container, 'Lernabschnitt 8').textContent.replace(/\s+/g, ' ')

    expect(eight).toContain('3 beantwortet · 4 offen')
    expect(eight).toContain('43 %')
    expect(eight).toContain('Resume: Ja')
    expect(eight).toContain('Weiterlernen')
    expect(sectionCard(second.container, 'Lernabschnitt 1').textContent).toContain('0 %')
  })

  it('reload and repeated app restarts without re-import: exact resume (same order, question, options and score)', async () => {
    let app = await importAll()

    await learn(app, 'Lernabschnitt 8', [true, false])
    await next(app.container)
    const shownHeading = heading(app.container)
    const shownOrder = (await withStore((store) => store.getLatestSectionSession('la08'))).orderedQuestionIds

    await settle()

    for (let restart = 0; restart < 3; restart++) {
      app = await reloadWithoutImport(app)
      await openSection(app.container, 'Lernabschnitt 8')
      expect(app.container.querySelector('[aria-label="Lernrunde"]').textContent).toContain('Frage 3 von 7 · 2 beantwortet · 1 richtig · 1 falsch · 5 offen')
      await resume(app.container)

      expect(heading(app.container)).toBe(shownHeading)
      expect(scoreText(app.container)).toContain('Frage 3 von 7')
      expect(scoreText(app.container)).toContain('Score: 1')
      expect(app.container.querySelector('.feedback-box')).toBeNull()
      expect((await withStore((store) => store.getLatestSectionSession('la08'))).orderedQuestionIds).toEqual(shownOrder)
    }
  })

  it('an answered question is restored without double counting after a reload (case B)', async () => {
    const first = await importAll()

    await openSection(first.container, 'Lernabschnitt 1')
    await startQuiz(first.container)
    const shownHeading = heading(first.container)
    const id = await answer(first.container, false)

    await settle()

    const second = await reloadWithoutImport(first)

    await openSection(second.container, 'Lernabschnitt 1')
    await resume(second.container)
    expect(heading(second.container)).toBe(shownHeading)
    expect(second.container.querySelector('.feedback-wrong')).not.toBeNull()
    expect(scoreText(second.container)).toContain('Score: 0')
    expect((await withStore((store) => store.listAllProgress())).filter((record) => record.questionId === id)[0]).toMatchObject({ attempts: 1 })
  })

  it('a later import into the same section leaves the running round untouched; new questions come with the next round', async () => {
    const first = await importAll()

    await learn(first, 'Lernabschnitt 8', [true, true])
    const before = await withStore((store) => store.getLatestSectionSession('la08'))

    const second = await reloadWithoutImport(first)
    const extra = lib('lib-eight-c', 'la08', 'sec-a68', { count: 3 })

    await importFiles(second.container, [file(extra)])
    expect(second.container.querySelector('.import-report').textContent).toContain('Neu importiert')
    await openSection(second.container, 'Lernabschnitt 8')

    const panel = second.container.querySelector('[aria-label="Lernrunde"]').textContent

    expect(panel).toContain('Lernrunde läuft')
    expect(panel).toContain('3 neue Fragen im Lernabschnitt kommen erst ab der nächsten Runde dazu')
    expect(sectionCard(second.container, 'Lernabschnitt 8').textContent).toContain('3 Libraries')
    expect(await withStore((store) => store.getLatestSectionSession('la08'))).toEqual(before)

    await resume(second.container)
    expect(scoreText(second.container)).toContain('Frage 2 von 7')
    expect(scoreText(second.container)).toContain('Score: 2')

    // Nächste Runde: alle 10 Fragen.
    const third = await reloadWithoutImport(second)

    await openSection(third.container, 'Lernabschnitt 8')
    buttonByText(third.container, 'Aktuelle Runde verwerfen und neu starten').click()
    await vi.waitFor(() => expect(heading(third.container)).not.toBeNull())
    await settle()
    expect((await withStore((store) => store.getLatestSectionSession('la08'))).orderedQuestionIds).toHaveLength(10)
    expect((await withStore((store) => store.listAllProgress())).length).toBe(2)
  })

  it('retired/historical progress does not count as an active question on the card', async () => {
    const first = await importAll()

    await withStore(async (store) => {
      await store.upsertQuestionProgress({
        libraryId: 'lib-two', questionId: 'sec-a02-0099', attempts: 2, correctCount: 2, incorrectCount: 0,
        lastResult: 'correct', answered: true, lastAnsweredAt: 5,
      })
      await store.upsertQuestionProgress({
        libraryId: 'lib-two', questionId: 'sec-a02-0001', attempts: 1, correctCount: 1, incorrectCount: 0,
        lastResult: 'correct', answered: true, lastAnsweredAt: 5, historical: true, migratedTo: { libraryId: 'lib-two', questionId: 'sec-a02-0002' },
      })
    })

    const second = await reloadWithoutImport(first)
    await vi.waitFor(() => expect(sectionCards(second.container)).toHaveLength(3))
    expect(sectionCard(second.container, 'Lernabschnitt 2').textContent.replace(/\s+/g, ' ')).toContain('0 beantwortet · 3 offen')
  })

  it('update in a batch: pending update is confirmed in the report and the card updates automatically', async () => {
    const first = await importAll()
    const updated = lib('lib-two', 'la02', 'sec-a02', { count: 4, libraryVersion: '1.1.0', activeQuestionIndexHash: hash('b') })
    const second = await reloadWithoutImport(first)

    await importFiles(second.container, [file(updated, 'lib-two-v2.json')])
    expect(second.container.querySelector('.library-message-error').textContent).toContain('Update benötigt Bestätigung')
    expect(sectionCard(second.container, 'Lernabschnitt 2').textContent).toContain('3 Fragen')

    buttonByText(second.container, 'Aktualisierung übernehmen').click()
    await vi.waitFor(() => expect(sectionCard(second.container, 'Lernabschnitt 2').textContent).toContain('4 Fragen'))
    expect(buttonByText(second.container, 'Aktualisierung übernehmen')).toBeUndefined()
    expect(second.container.querySelector('.import-report').textContent).toContain('Aktualisiert')
  })

  it('a duplicate active question id across libraries is blocked and shown', async () => {
    const first = await importAll()
    const second = await reloadWithoutImport(first)
    const clash = lib('lib-clash', 'la05', 'sec-a02')

    await importFiles(second.container, [file(clash)])
    expect(second.container.querySelector('.library-message-error').textContent).toContain('Abgelehnt')
    expect(second.container.querySelector('.library-message-error').textContent).toContain('lib-two')
    expect(sectionCard(second.container, 'Lernabschnitt 5')).toBeUndefined()
  })
})
