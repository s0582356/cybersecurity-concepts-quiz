// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buttonByText,
  heading,
  importJson,
  mountApp,
  reload,
  resetBrowserStorage,
  resume,
  scoreText,
  settle,
  unmountAll,
  withStore,
} from './helpers/appHarness.js'
import { makeSyntheticLibrary } from './fixtures/syntheticLibrary.js'
import { applyAnswer, createSessionRecord } from '../src/domain/session.js'
import { parseV2Library } from '../src/lib/library/parseLibrary.js'

const A = 'app-repl-a'
const B = 'app-repl-b'
const HASH_2 = `sha256:${'4'.repeat(64)}`
const REGISTRY = {
  'sec-a30-0004': {
    replacedBy: 'sec-a31-0001',
    progressMigration: 'inherit',
    learningGoalEquivalence: 'confirmed',
    reason: 'synthetisch',
  },
}

beforeEach(resetBrowserStorage)
afterEach(unmountAll)

const libA = (options = {}) => makeSyntheticLibrary({ libraryId: A, idPrefix: 'sec-a30', ...options })
const libB = () => makeSyntheticLibrary({ libraryId: B, idPrefix: 'sec-a31', count: 3 })
const aV2 = () => libA({ libraryVersion: '2.0.0', activeQuestionIndexHash: HASH_2, omitIds: ['sec-a30-0004'] })

async function importRegistry(container, data, fileName = 'retired-index.json') {
  const input = container.querySelector('input[type="file"]')

  Object.defineProperty(input, 'files', {
    value: [{ name: fileName, text: async () => JSON.stringify(data) }],
    configurable: true,
  })
  input.dispatchEvent(new Event('change'))
  await settle(120)
}

// Beide Bibliotheken bekannt, Fortschritt auf der später entfernten Frage.
async function prepare() {
  const first = mountApp()
  await importJson(first.container, libA(), 'a.json')
  const second = await reload(first, libB(), 'b.json')

  await withStore(async (store) => {
    await store.recordAnswer({ libraryId: A, questionId: 'sec-a30-0004', isCorrect: false, answeredAt: 100 })
    await store.recordAnswer({ libraryId: A, questionId: 'sec-a30-0004', isCorrect: true, answeredAt: 200 })
  })

  return second
}

describe('replacement migration in the app', () => {
  it('blocks a removal that no loaded registry explains and asks for the registry', async () => {
    const app = await prepare()
    const next = await reload(app, aV2(), 'a2.json')
    const message = next.container.querySelector('.library-message-error').textContent

    expect(message).toContain('Ersetzungs-Index')
    expect(buttonByText(next.container, 'Aktualisierung übernehmen')).toBeUndefined()
    expect(await withStore((store) => store.getQuestionProgress(B, 'sec-a31-0001'))).toBeNull()
    expect((await withStore((store) => store.getLibraryState(A))).libraryVersion).toBe('1.0.0')
  })

  it('rejects an invalid registry with a message and stores nothing', async () => {
    const app = await prepare()

    await importRegistry(app.container, { 'sec-a30-0004': { replacedBy: 'sec-a31-0001', progressMigration: 'inherit' } })

    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('learningGoalEquivalence'))
    expect(await withStore((store) => store.getRetiredIndex())).toBeNull()
  })

  it('loads the registry, offers the replacement and applies it only after confirmation', async () => {
    const app = await prepare()

    await importRegistry(app.container, REGISTRY)
    expect(app.container.querySelector('.library-message-info').textContent).toContain('1 Einträge')

    const stored = await withStore((store) => store.getRetiredIndex())

    expect(stored).toEqual({
      'sec-a30-0004': { replacedBy: 'sec-a31-0001', progressMigration: 'inherit', learningGoalEquivalence: 'confirmed' },
    })

    // Neustart der App: Registry bleibt gespeichert und wird beim Update verwendet.
    const next = await reload(app, aV2(), 'a2.json')
    const message = next.container.querySelector('.library-message-error').textContent

    expect(message).toContain('1 Fragen wurden ersetzt: 1 übernehmen den bisherigen Fortschritt')
    expect(message).not.toContain('sha256')
    expect(await withStore((store) => store.getQuestionProgress(B, 'sec-a31-0001'))).toBeNull()

    buttonByText(next.container, 'Aktualisierung übernehmen').click()
    await vi.waitFor(() => expect(next.container.querySelector('.question-bank-label').textContent).toContain('a2.json'))
    await settle()

    const target = await withStore((store) => store.getQuestionProgress(B, 'sec-a31-0001'))
    const source = await withStore((store) => store.getQuestionProgress(A, 'sec-a30-0004'))

    expect(target).toMatchObject({ attempts: 2, correctCount: 1, incorrectCount: 1, lastResult: 'correct', answered: true })
    expect(source).toMatchObject({ historical: true, migratedTo: { libraryId: B, questionId: 'sec-a31-0001' } })

    // Reload + erneuter Import: unverändert, kein weiteres Update.
    const again = await reload(next, aV2(), 'a2.json')

    expect(again.container.querySelector('.library-message').textContent).toContain('Bekannte Bibliothek')
    expect(await withStore((store) => store.getQuestionProgress(B, 'sec-a31-0001'))).toEqual(target)
    expect((await withStore((store) => store.listProgressForLibrary(B))).length).toBe(1)
  })

  it('shows the inherited progress of the keep question in the stored-progress panel', async () => {
    const app = await prepare()

    await importRegistry(app.container, REGISTRY)
    const next = await reload(app, aV2(), 'a2.json')

    buttonByText(next.container, 'Aktualisierung übernehmen').click()
    await vi.waitFor(() => expect(next.container.querySelector('.question-bank-label').textContent).toContain('a2.json'))

    const afterB = await reload(next, libB(), 'b.json')
    const summary = afterB.container.querySelector('[aria-label="Gespeicherter Fortschritt"]').textContent

    expect(summary).toContain('Beantwortet: 1 von 3')
    expect(summary).toContain('Versuche gesamt: 2')
  })

  it('same-library reset: the resumed round shows streaks derived from the remaining credit', async () => {
    const first = mountApp()

    await importJson(first.container, libA(), 'a.json')

    // Runde 1 ✓, 2 ✓, 4 ✓ (später ersetzt) – Serie 3, Bestwert 3
    const { library } = parseV2Library(libA())
    let session = createSessionRecord({
      sessionId: 'streak-round',
      library,
      orderedQuestionIds: ['sec-a30-0001', 'sec-a30-0002', 'sec-a30-0004', 'sec-a30-0003'],
    })

    for (const questionId of ['sec-a30-0001', 'sec-a30-0002', 'sec-a30-0004']) {
      session = applyAnswer(session, { questionId, isCorrect: true }).session
    }

    await withStore((store) => store.startNewSession(session))
    await importRegistry(first.container, {
      'sec-a30-0004': { replacedBy: 'sec-a30-0005', progressMigration: 'reset', reason: 'synthetisch' },
    })

    const updated = libA({ libraryVersion: '2.0.0', activeQuestionIndexHash: HASH_2, count: 5, omitIds: ['sec-a30-0004'] })
    const second = await reload(first, updated, 'a2.json')

    buttonByText(second.container, 'Aktualisierung übernehmen').click()
    await vi.waitFor(() => expect(buttonByText(second.container, 'Lernrunde fortsetzen')).toBeDefined())
    await resume(second.container)

    expect(heading(second.container)).toBe('Synthetische Frage 0005?')
    expect(scoreText(second.container)).toContain('Score: 2')
    expect(scoreText(second.container)).toContain('Aktuelle Serie: 2')
    expect(scoreText(second.container)).toContain('Beste Serie: 2')

    // Reload nach der Migration: dieselben Werte
    const third = await reload(second, updated, 'a2.json')

    await resume(third.container)
    expect(scoreText(third.container)).toContain('Aktuelle Serie: 2')
    expect(scoreText(third.container)).toContain('Beste Serie: 2')
  })
})
