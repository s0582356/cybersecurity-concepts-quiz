// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  answerButtons,
  answerCurrent,
  buttonByText,
  heading,
  importJson,
  mountApp,
  next,
  reload,
  resetBrowserStorage,
  resume,
  scoreText,
  settle,
  startQuiz,
  unmountAll,
  unmountApp,
  withStore,
} from './helpers/appHarness.js'
import { makeSyntheticLibrary } from './fixtures/syntheticLibrary.js'

const LIBRARY_ID = 'app-update-library'
const HASH_2 = `sha256:${'d'.repeat(64)}`
const INTRO = 'Diese Bibliothek wurde aktualisiert. Dein bisheriger Lernfortschritt bleibt gespeichert'

beforeEach(resetBrowserStorage)
afterEach(unmountAll)

function library(options = {}) {
  return makeSyntheticLibrary({ libraryId: LIBRARY_ID, count: 4, ...options })
}

async function roundWithTwoAnswers(source = library()) {
  const app = mountApp()
  await importJson(app.container, source)
  await startQuiz(app.container)
  const first = await answerCurrent(app.container, source, { correct: true })
  await next(app.container)
  await answerCurrent(app.container, source, { correct: false })
  await settle()

  return { app, first }
}

describe('library update in the app', () => {
  it('case B: new PATCH version with the same hash keeps progress and the exact round', async () => {
    const original = library()
    const { app } = await roundWithTwoAnswers(original)
    const before = await withStore((store) => store.getLatestSession(LIBRARY_ID))
    const secondHeading = heading(app.container)

    const patched = library({ libraryVersion: '1.0.1' })
    const second = await reload(app, patched, 'patched.json')

    expect(second.container.querySelector('.library-message').textContent).toContain('neuerer Version')
    expect(second.container.querySelector('.library-message-error')).toBeNull()
    await resume(second.container)
    expect(heading(second.container)).toBe(secondHeading)
    expect(scoreText(second.container)).toContain('Score: 1')

    const { state, session } = await withStore(async (store) => ({
      state: await store.getLibraryState(LIBRARY_ID),
      session: await store.getLatestSession(LIBRARY_ID),
    }))

    expect(state.libraryVersion).toBe('1.0.1')
    expect(session.orderedQuestionIds).toEqual(before.orderedQuestionIds)
    expect(session.sessionId).toBe(before.sessionId)
  })

  it('case C: changed hash is controlled, shows the migration message and changes nothing', async () => {
    const { app } = await roundWithTwoAnswers()
    const before = await withStore(async (store) => ({
      state: await store.getLibraryState(LIBRARY_ID),
      session: await store.getLatestSession(LIBRARY_ID),
      progress: await store.listProgressForLibrary(LIBRARY_ID),
    }))

    // Abweichung, die in dieser Phase nicht übernommen werden kann (Frage entfernt).
    const removed = library({ libraryVersion: '2.0.0', activeQuestionIndexHash: HASH_2, omitIds: ['sec-a30-0004'] })
    const second = await reload(app, removed, 'removed.json')
    const message = second.container.querySelector('.library-message-error').textContent

    expect(message).toContain(INTRO)
    expect(message).toContain('Fortschrittsmigration')
    expect(message).not.toContain('sha256')
    expect(buttonByText(second.container, 'Aktualisierung übernehmen')).toBeUndefined()
    expect(buttonByText(second.container, 'Lernrunde fortsetzen')).toBeUndefined()
    expect(second.container.querySelector('.question-bank-label').textContent).not.toContain('removed.json')

    const after = await withStore(async (store) => ({
      state: await store.getLibraryState(LIBRARY_ID),
      session: await store.getLatestSession(LIBRARY_ID),
      progress: await store.listProgressForLibrary(LIBRARY_ID),
    }))

    expect(after).toEqual(before)
  })

  it('same version with a changed hash offers no update', async () => {
    const { app } = await roundWithTwoAnswers()
    const second = await reload(app, library({ activeQuestionIndexHash: HASH_2 }), 'odd.json')

    expect(second.container.querySelector('.library-message-error').textContent).toContain(INTRO)
    expect(buttonByText(second.container, 'Aktualisierung übernehmen')).toBeUndefined()
  })

  it('revised questions: the update is only applied after confirmation, progress and round stay', async () => {
    const { app } = await roundWithTwoAnswers()
    const orderBefore = (await withStore((store) => store.getLatestSession(LIBRARY_ID))).orderedQuestionIds
    const currentHeading = heading(app.container)
    const progressBefore = await withStore((store) => store.listProgressForLibrary(LIBRARY_ID))

    // Eine andere Frage als die aktuelle wurde überarbeitet.
    const revisedId = orderBefore[3]
    const updated = library({
      libraryVersion: '1.1.0',
      activeQuestionIndexHash: HASH_2,
      contentRevisions: { [revisedId]: 2 },
    })
    const second = await reload(app, updated, 'updated.json')

    expect(second.container.querySelector('.library-message-error').textContent).toContain('1 Fragen wurden überarbeitet')
    expect(second.container.querySelector('.question-bank-label').textContent).not.toContain('updated.json')
    expect(await withStore((store) => store.getLibraryState(LIBRARY_ID))).toMatchObject({ libraryVersion: '1.0.0' })

    buttonByText(second.container, 'Aktualisierung übernehmen').click()
    await vi.waitFor(() => expect(second.container.querySelector('.question-bank-label').textContent).toContain('updated.json'))
    await settle()

    expect(second.container.querySelector('.library-message').textContent).toContain('Version 1.1.0')
    expect(second.container.querySelector('[aria-label="Bibliotheks-Update"]')).toBeNull()

    await resume(second.container)
    expect(heading(second.container)).toBe(currentHeading)
    expect(scoreText(second.container)).toContain('Score: 1')

    const after = await withStore(async (store) => ({
      state: await store.getLibraryState(LIBRARY_ID),
      session: await store.getLatestSession(LIBRARY_ID),
      progress: await store.listProgressForLibrary(LIBRARY_ID),
    }))

    expect(after.state).toMatchObject({ libraryVersion: '1.1.0', activeQuestionIndexHash: HASH_2 })
    expect(after.session.orderedQuestionIds).toEqual(orderBefore)
    expect(after.progress).toEqual(progressBefore)
  })

  it('revised current question: the old chosen option is not shown as current response', async () => {
    const source = library()
    const app = mountApp()
    await importJson(app.container, source)
    await startQuiz(app.container)
    const answeredId = await answerCurrent(app.container, source, { correct: false })
    await settle()

    const updated = library({
      libraryVersion: '1.1.0',
      activeQuestionIndexHash: HASH_2,
      contentRevisions: { [answeredId]: 2 },
    })
    const second = await reload(app, updated, 'updated.json')

    buttonByText(second.container, 'Aktualisierung übernehmen').click()
    await vi.waitFor(() => expect(buttonByText(second.container, 'Lernrunde fortsetzen')).toBeDefined())
    await resume(second.container)

    // Antwort bleibt als beantwortet (kein Doppelzählen), aber die frühere Auswahl wird nicht markiert.
    expect(second.container.querySelector('.feedback-wrong')).not.toBeNull()
    expect(second.container.querySelectorAll('.answer-wrong')).toHaveLength(0)
    expect(answerButtons(second.container).every((button) => button.disabled)).toBe(true)
    expect(scoreText(second.container)).toContain('Score: 0')

    const session = await withStore((store) => store.getLatestSession(LIBRARY_ID))

    expect(session.currentQuestionState).toMatchObject({ questionId: answeredId, selectedOptionKey: null, optionOrder: null })
    expect(session.answeredQuestionIds).toEqual([answeredId])
  })

  it('added questions: after confirmation the old round stays blocked and no progress is invented', async () => {
    const { app } = await roundWithTwoAnswers()
    const updated = library({ libraryVersion: '1.1.0', activeQuestionIndexHash: HASH_2, count: 5 })
    const second = await reload(app, updated, 'bigger.json')

    expect(second.container.querySelector('.library-message-error').textContent).toContain('1 Fragen sind neu')
    buttonByText(second.container, 'Aktualisierung übernehmen').click()
    await vi.waitFor(() => expect(second.container.querySelector('[aria-label="Lernrunde"]')).not.toBeNull())

    const panel = second.container.querySelector('[aria-label="Lernrunde"]')

    expect(panel.textContent).toContain('Lernrunde kann nicht fortgesetzt werden')
    expect(buttonByText(second.container, 'Lernrunde fortsetzen')).toBeUndefined()
    expect(await withStore((store) => store.listProgressForLibrary(LIBRARY_ID))).toHaveLength(2)

    // Bewusster Neustart ist möglich; Lebenszeit-Fortschritt bleibt.
    buttonByText(second.container, 'Runde verwerfen und neu starten').click()
    await vi.waitFor(() => expect(heading(second.container)).not.toBeNull())
    expect(await withStore((store) => store.listProgressForLibrary(LIBRARY_ID))).toHaveLength(2)
  })

  it('repeated import of the same file is idempotent', async () => {
    const source = library()
    const { app } = await roundWithTwoAnswers(source)
    let current = app

    for (let round = 0; round < 3; round++) {
      current = await reload(current, source)
    }

    const counts = await withStore(async (store) => ({
      progress: (await store.listProgressForLibrary(LIBRARY_ID)).length,
      session: (await store.getLatestSession(LIBRARY_ID)).answeredQuestionIds.length,
    }))

    expect(counts).toEqual({ progress: 2, session: 2 })
    unmountApp(current)
  })
})
