import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProgressStore } from '../src/storage/progressStore.js'
import { applyLibraryUpdate, registerLibraryImport } from '../src/storage/libraryImport.js'
import { parseRetiredIndex } from '../src/domain/replacementMigration.js'
import { createSessionRecord } from '../src/domain/session.js'
import { parseV2Library } from '../src/lib/library/parseLibrary.js'
import { EXAM_ERROR } from '../src/domain/examSelection.js'
import { createExamAttempt, finalizeExamAttemptRecord, presentExamQuestion } from '../src/domain/examAttempt.js'
import { buildExamPool, readExamPool, startExam } from '../src/storage/examService.js'
import { clone, importExamLibraries, makeExamLibraryData, seededRandom } from './fixtures/examFixtures.js'

const SIZES = { la01: 12, la02: 20, la03: 8 }
const TOTAL = 40

let dbName
let openStores

function openStore() {
  const store = createProgressStore({ dbName })
  openStores.push(store)
  return store
}

async function readyStore(options) {
  const store = openStore()

  await store.initialize()
  await importExamLibraries(store, makeExamLibraryData(SIZES, options))

  return store
}

// Reload = Datenbankverbindung schließen und neu öffnen.
async function reopen(store) {
  store.close()

  const next = openStore()

  await next.initialize()

  return next
}

const correctKey = (attempt, id) => attempt.questionSnapshots[id].correctOptionKey
const wrongKey = (attempt, id) => ['a', 'b', 'c', 'd'].find((key) => key !== correctKey(attempt, id))

async function startedAttempt(store, options = {}) {
  const { started, attempt } = await startExam(store, { count: 20, random: seededRandom(1), now: 1000, ...options })

  expect(started).toBe(true)

  return attempt
}

function rawDelete(name, storeNames) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name)

    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction(storeNames, 'readwrite')

      storeNames.forEach((storeName) => transaction.objectStore(storeName).clear())
      transaction.oncomplete = () => {
        database.close()
        resolve()
      }
      transaction.onerror = () => reject(transaction.error)
    }
    request.onerror = () => reject(request.error)
  })
}

function rawPut(name, storeName, record) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name)

    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction(storeName, 'readwrite')

      transaction.objectStore(storeName).put(record)
      transaction.oncomplete = () => {
        database.close()
        resolve()
      }
      transaction.onerror = () => reject(transaction.error)
    }
    request.onerror = () => reject(request.error)
  })
}

beforeEach(() => {
  dbName = `exam-db-${Math.random().toString(36).slice(2)}`
  openStores = []
})

afterEach(() => {
  openStores.forEach((store) => store.close())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('exam pool', () => {
  it('contains every active question of all catalogued libraries, each exactly once', async () => {
    const store = await readyStore()
    const { pool, libraries, excludedLibraryIds } = await readExamPool(store)

    expect(pool).toHaveLength(TOTAL)
    expect(new Set(pool.map((entry) => entry.question.id)).size).toBe(TOTAL)
    expect(libraries).toHaveLength(3)
    expect(excludedLibraryIds).toEqual([])
    expect(pool.filter((entry) => entry.sectionId === 'la02')).toHaveLength(20)
  })

  it('excludes a library whose stored content does not match its state hash instead of using it silently', async () => {
    const store = await readyStore()
    const states = await store.listLibraryStates()
    const loaded = await Promise.all(states.map((state) => store.getLibraryContent(state.libraryId)))
    const contents = loaded.map((content, index) => (index === 0 ? { ...content, activeQuestionIndexHash: `sha256:${'f'.repeat(64)}` } : content))
    const { pool, excludedLibraryIds } = buildExamPool({ states, contents })

    expect(excludedLibraryIds).toEqual([states[0].libraryId])
    expect(pool.some((entry) => entry.libraryId === states[0].libraryId)).toBe(false)
  })

  it('does not include uncatalogued (pre-2E) library states', async () => {
    const store = await readyStore()

    await store.upsertLibraryState({ libraryId: 'old-lib', libraryVersion: '1.0.0', activeQuestionIndexHash: `sha256:${'9'.repeat(64)}`, firstImportedAt: 1, lastAccessedAt: 1 })

    expect((await readExamPool(store)).pool).toHaveLength(TOTAL)
  })

  it('fails with a clean error when the pool is too small', async () => {
    const store = openStore()

    await store.initialize()
    await importExamLibraries(store, makeExamLibraryData({ la01: 6 }))

    await expect(startExam(store, { count: 6 })).rejects.toMatchObject({ code: EXAM_ERROR.POOL_TOO_SMALL })
    expect(await store.listExamAttempts()).toEqual([])
  })
})

describe('exam attempt persistence', () => {
  it('starts, persists and reads back a running attempt (DE)', async () => {
    const store = await readyStore()
    const attempt = await startedAttempt(store)

    expect(await store.getExamAttempt(attempt.examSessionId)).toEqual(attempt)
    expect(await store.getActiveExamAttempt()).toEqual(attempt)
    expect(await store.listExamAttempts()).toEqual([attempt])
    expect(attempt).toMatchObject({ status: 'inProgress', sessionLanguage: 'de', languageMode: null, questionCount: 20 })
    expect(await store.getExamAttempt('does-not-exist')).toBeNull()
  })

  it('caps every preset at the pool size (N = min(preset, pool)) and keeps the chosen preset', async () => {
    const store = await readyStore()

    for (const [preset, expected] of [['short', 20], ['medium', 40], ['long', 40]]) {
      const { attempt } = await startExam(store, { preset, random: seededRandom(1) })

      expect(attempt).toMatchObject({ examPreset: preset, questionCount: expected })
      expect(attempt.orderedQuestionIds).toHaveLength(expected)
      expect(new Set(attempt.orderedQuestionIds).size).toBe(expected)
      await store.discardActiveExamAttempt(attempt.examSessionId)
    }

    // Default (ohne Argument) = Mittel, gekappt auf den 40er-Pool.
    const { attempt } = await startExam(store)

    expect(attempt).toMatchObject({ examPreset: 'medium', questionCount: 40 })
    expect(await store.getExamAttempt(attempt.examSessionId)).toEqual(attempt)
  })

  it('stores a deep, structured copy: later changes of the passed object do not reach the database', async () => {
    const store = await readyStore()
    const { pool, libraries } = await readExamPool(store)
    const attempt = createExamAttempt({ pool, libraries, count: 20, random: seededRandom(1) })
    const before = clone(attempt)

    await store.startExamAttempt(attempt)
    attempt.answers.x = 'a'
    attempt.orderedQuestionIds.reverse()

    expect(await store.getExamAttempt(before.examSessionId)).toEqual(before)
  })

  it('blocks a second running attempt and a duplicate id; rejects an invalid or already submitted record', async () => {
    const store = await readyStore()
    const first = await startedAttempt(store)
    const { pool, libraries } = await readExamPool(store)
    const second = createExamAttempt({ pool, libraries, count: 10 })

    expect(await store.startExamAttempt(second)).toEqual({ started: false, reason: 'activeExists' })
    expect(await store.listExamAttempts()).toEqual([first])

    await store.finalizeExamAttempt(first.examSessionId, 2000)
    expect(await store.startExamAttempt({ ...second, examSessionId: first.examSessionId })).toEqual({ started: false, reason: 'duplicateId' })

    expect(await store.startExamAttempt({ ...second, currentIndex: 99 })).toMatchObject({ started: false, reason: 'invalid' })
    expect(await store.startExamAttempt(finalizeExamAttemptRecord(second, 5).attempt)).toMatchObject({ started: false, reason: 'invalid' })
    expect(await store.listExamAttempts()).toHaveLength(1)
  })

  it('discards a running attempt only, reports unknown ids and never deletes a submitted attempt (Phase 3D)', async () => {
    const store = await readyStore()
    const attempt = await startedAttempt(store)

    expect(await store.discardActiveExamAttempt(attempt.examSessionId)).toEqual({ discarded: true })
    expect(await store.getActiveExamAttempt()).toBeNull()
    expect(await store.discardActiveExamAttempt(attempt.examSessionId)).toEqual({ discarded: false, reason: 'notFound' })

    const second = await startedAttempt(store)
    const { attempt: done } = await store.finalizeExamAttempt(second.examSessionId, 2000)

    expect(await store.discardActiveExamAttempt(second.examSessionId)).toEqual({ discarded: false, reason: 'notActive' })
    expect(await store.getExamAttempt(second.examSessionId)).toEqual(done)
  })
})

describe('answers and navigation', () => {
  it('persists an answer, replaces it and keeps the order untouched', async () => {
    const store = await readyStore()
    const attempt = await startedAttempt(store)
    const [, id] = attempt.orderedQuestionIds

    const first = await store.recordExamAnswer({ examSessionId: attempt.examSessionId, questionId: id, selectedOptionKey: 'b', now: 1100 })

    expect(first.recorded).toBe(true)
    expect((await store.getExamAttempt(attempt.examSessionId)).answers).toEqual({ [id]: 'b' })

    await store.recordExamAnswer({ examSessionId: attempt.examSessionId, questionId: id, selectedOptionKey: 'd', now: 1200 })

    const stored = await store.getExamAttempt(attempt.examSessionId)

    expect(stored).toMatchObject({ answers: { [id]: 'd' }, currentIndex: 1, currentQuestionId: id, lastActivityAt: 1200 })
    expect(stored.orderedQuestionIds).toEqual(attempt.orderedQuestionIds)
    expect(stored.optionOrder).toEqual(attempt.optionOrder)
    expect(stored.questionSnapshots).toEqual(attempt.questionSnapshots)
  })

  it('rejects an invalid option key, an unknown question and an unknown attempt without writing', async () => {
    const store = await readyStore()
    const attempt = await startedAttempt(store)
    const id = attempt.orderedQuestionIds[0]

    expect(await store.recordExamAnswer({ examSessionId: attempt.examSessionId, questionId: id, selectedOptionKey: 'z' })).toMatchObject({ recorded: false, reason: 'invalidOption' })
    expect(await store.recordExamAnswer({ examSessionId: attempt.examSessionId, questionId: 'sec-a77-0001', selectedOptionKey: 'a' })).toMatchObject({ recorded: false, reason: 'unknownQuestion' })
    expect(await store.recordExamAnswer({ examSessionId: 'nope', questionId: id, selectedOptionKey: 'a' })).toEqual({ recorded: false, reason: 'notFound' })
    expect(await store.getExamAttempt(attempt.examSessionId)).toEqual(attempt)
  })

  it('persists navigation (next / previous / direct) and refuses out-of-range targets', async () => {
    const store = await readyStore()
    const attempt = await startedAttempt(store)
    const ids = attempt.orderedQuestionIds
    const examSessionId = attempt.examSessionId

    await store.setExamPosition({ examSessionId, direction: 'next', now: 1100 })
    expect(await store.getExamAttempt(examSessionId)).toMatchObject({ currentIndex: 1, currentQuestionId: ids[1], lastActivityAt: 1100 })

    await store.setExamPosition({ examSessionId, index: 19 })
    expect((await store.getExamAttempt(examSessionId)).currentQuestionId).toBe(ids[19])

    expect(await store.setExamPosition({ examSessionId, direction: 'next' })).toMatchObject({ moved: false, reason: 'outOfRange' })
    await store.setExamPosition({ examSessionId, direction: 'previous' })
    expect((await store.getExamAttempt(examSessionId)).currentIndex).toBe(18)

    await store.setExamPosition({ examSessionId, questionId: ids[0] })
    expect(await store.setExamPosition({ examSessionId, direction: 'previous' })).toMatchObject({ moved: false, reason: 'outOfRange' })
    expect(await store.setExamPosition({ examSessionId, index: 20 })).toMatchObject({ moved: false, reason: 'outOfRange' })
    expect(await store.setExamPosition({ examSessionId: 'nope', index: 1 })).toEqual({ moved: false, reason: 'notFound' })
    expect((await store.getExamAttempt(examSessionId)).currentIndex).toBe(0)
  })

  it('refuses to change a damaged record and leaves it as it is', async () => {
    const store = await readyStore()
    const attempt = await startedAttempt(store)
    const damaged = { ...clone(attempt), currentIndex: 99 }

    await rawPut(dbName, 'examAttempts', damaged)

    expect(await store.recordExamAnswer({ examSessionId: attempt.examSessionId, questionId: attempt.orderedQuestionIds[0], selectedOptionKey: 'a' })).toMatchObject({ recorded: false, reason: 'invalid' })
    expect(await store.finalizeExamAttempt(attempt.examSessionId)).toMatchObject({ finalized: false, reason: 'invalid' })
    expect(await store.getExamAttempt(attempt.examSessionId)).toEqual(damaged)
  })
})

describe('exact resume', () => {
  it('keeps every contract field identical across repeated reloads', async () => {
    let store = await readyStore()
    const attempt = await startedAttempt(store, { language: 'en' })
    const ids = attempt.orderedQuestionIds

    await store.recordExamAnswer({ examSessionId: attempt.examSessionId, questionId: ids[0], selectedOptionKey: 'c', now: 1100 })
    await store.recordExamAnswer({ examSessionId: attempt.examSessionId, questionId: ids[5], selectedOptionKey: 'a', now: 1200 })
    await store.recordExamAnswer({ examSessionId: attempt.examSessionId, questionId: ids[5], selectedOptionKey: 'd', now: 1300 })
    await store.setExamPosition({ examSessionId: attempt.examSessionId, index: 9, now: 1400 })

    const expected = await store.getExamAttempt(attempt.examSessionId)

    for (let reload = 0; reload < 3; reload++) {
      store = await reopen(store)

      const resumed = await store.getActiveExamAttempt()

      expect(resumed).toEqual(expected)
      expect(resumed).toMatchObject({
        examSessionId: attempt.examSessionId,
        status: 'inProgress',
        currentIndex: 9,
        currentQuestionId: ids[9],
        sessionLanguage: 'en',
        languageMode: 'onlyEnglish',
        sessionStartedAt: 1000,
        answers: { [ids[0]]: 'c', [ids[5]]: 'd' },
      })
      expect(resumed.orderedQuestionIds).toEqual(ids)
      expect(resumed.optionOrder).toEqual(attempt.optionOrder)
      expect(resumed.questionSnapshots).toEqual(attempt.questionSnapshots)
      expect(presentExamQuestion(resumed, ids[5])).toMatchObject({ selectedKey: 'd', index: 5 })
    }
  })

  it('does not re-randomize: the stored order does not depend on later RNG or on the library state', async () => {
    let store = await readyStore()
    const attempt = await startedAttempt(store, { random: seededRandom(5) })

    // Eine neue Auswahl mit anderem RNG ergibt eine andere Reihenfolge, der gespeicherte Versuch bleibt davon unberührt.
    const other = createExamAttempt({ ...(await readExamPool(store)), count: 20, random: seededRandom(6) })

    expect(other.orderedQuestionIds).not.toEqual(attempt.orderedQuestionIds)
    store = await reopen(store)
    expect((await store.getActiveExamAttempt()).orderedQuestionIds).toEqual(attempt.orderedQuestionIds)
  })

  it('does not change the language after a reload, whatever the app language is', async () => {
    let store = await readyStore()
    const attempt = await startedAttempt(store, { language: 'de' })

    globalThis.localStorage?.setItem?.('contentLocale', 'en')
    store = await reopen(store)

    const resumed = await store.getActiveExamAttempt()

    expect(resumed.sessionLanguage).toBe('de')
    expect(presentExamQuestion(resumed, attempt.orderedQuestionIds[0]).text).toContain('Frage')
  })
})

describe('submit', () => {
  it('finalizes atomically: status, completedAt and result are written together', async () => {
    const store = await readyStore()
    const attempt = await startedAttempt(store)
    const ids = attempt.orderedQuestionIds

    for (const id of ids.slice(0, 12)) {
      await store.recordExamAnswer({ examSessionId: attempt.examSessionId, questionId: id, selectedOptionKey: correctKey(attempt, id) })
    }

    for (const id of ids.slice(12, 15)) {
      await store.recordExamAnswer({ examSessionId: attempt.examSessionId, questionId: id, selectedOptionKey: wrongKey(attempt, id) })
    }

    const done = await store.finalizeExamAttempt(attempt.examSessionId, 9000)

    expect(done.finalized).toBe(true)
    expect(done.attempt).toMatchObject({ status: 'submitted', completedAt: 9000 })
    expect(done.attempt.result).toMatchObject({ total: 20, correct: 12, incorrect: 3, unanswered: 5, percent: 60, finalizedAt: 9000 })
    expect(await store.getExamAttempt(attempt.examSessionId)).toEqual(done.attempt)
  })

  it('is idempotent: repeated and parallel submits keep one result and change nothing', async () => {
    const store = await readyStore()
    const attempt = await startedAttempt(store)
    const id = attempt.orderedQuestionIds[0]

    await store.recordExamAnswer({ examSessionId: attempt.examSessionId, questionId: id, selectedOptionKey: correctKey(attempt, id) })

    const results = await Promise.all([
      store.finalizeExamAttempt(attempt.examSessionId, 5000),
      store.finalizeExamAttempt(attempt.examSessionId, 6000),
      store.finalizeExamAttempt(attempt.examSessionId, 7000),
    ])
    const stored = await store.getExamAttempt(attempt.examSessionId)

    expect(results.filter((result) => result.finalized)).toHaveLength(1)
    expect(stored.completedAt).toBe(results.find((result) => result.finalized).attempt.completedAt)

    const again = await store.finalizeExamAttempt(attempt.examSessionId, 99999)

    expect(again).toEqual({ finalized: false, reason: 'alreadySubmitted', attempt: stored })
    expect(await store.getExamAttempt(attempt.examSessionId)).toEqual(stored)
    expect(await store.listExamAttempts()).toHaveLength(1)
  })

  it('treats a submit of an unknown attempt as notFound', async () => {
    const store = await readyStore()

    expect(await store.finalizeExamAttempt('nope')).toEqual({ finalized: false, reason: 'notFound' })
  })

  it('is immutable afterwards: answers, navigation and result do not change; it is never a resumable attempt', async () => {
    let store = await readyStore()
    const attempt = await startedAttempt(store)
    const id = attempt.orderedQuestionIds[0]

    await store.recordExamAnswer({ examSessionId: attempt.examSessionId, questionId: id, selectedOptionKey: correctKey(attempt, id) })

    const { attempt: submitted } = await store.finalizeExamAttempt(attempt.examSessionId, 5000)

    expect(await store.recordExamAnswer({ examSessionId: attempt.examSessionId, questionId: id, selectedOptionKey: wrongKey(attempt, id) })).toMatchObject({ recorded: false, reason: 'submitted' })
    expect(await store.recordExamAnswer({ examSessionId: attempt.examSessionId, questionId: attempt.orderedQuestionIds[1], selectedOptionKey: 'a' })).toMatchObject({ recorded: false, reason: 'submitted' })
    expect(await store.setExamPosition({ examSessionId: attempt.examSessionId, index: 7 })).toMatchObject({ moved: false, reason: 'submitted' })
    expect(await store.setExamPosition({ examSessionId: attempt.examSessionId, direction: 'next' })).toMatchObject({ moved: false, reason: 'submitted' })

    store = await reopen(store)

    expect(await store.getExamAttempt(attempt.examSessionId)).toEqual(submitted)
    expect(await store.getActiveExamAttempt()).toBeNull()
    expect((await store.listExamAttempts())[0].status).toBe('submitted')
  })
})

// P3B-RT-004: echte Cross-Connection-Races (zwei Store-Instanzen = zwei IndexedDB-Verbindungen, wie zwei Tabs).
describe('cross-connection races', () => {
  async function twoTabs() {
    const tabA = await readyStore()
    const tabB = openStore()

    await tabB.initialize()

    return { tabA, tabB }
  }

  async function prepared(tab, seed) {
    const { pool, libraries } = await readExamPool(tab)

    return createExamAttempt({ pool, libraries, count: 20, random: seededRandom(seed), now: 1000 })
  }

  it('two nearly simultaneous starts: exactly one wins, the other gets activeExists, one running attempt remains', async () => {
    const { tabA, tabB } = await twoTabs()

    for (let round = 0; round < 6; round++) {
      const [first, second] = await Promise.all([prepared(tabA, 100 + round), prepared(tabB, 200 + round)])
      const results = await Promise.all([tabA.startExamAttempt(first), tabB.startExamAttempt(second)])

      expect(results.filter((result) => result.started)).toHaveLength(1)
      expect(results.filter((result) => !result.started)).toEqual([{ started: false, reason: 'activeExists' }])

      const running = (await tabA.listExamAttempts()).filter((attempt) => attempt.status === 'inProgress')

      expect(running).toHaveLength(1)
      expect([first.examSessionId, second.examSessionId]).toContain(running[0].examSessionId)
      expect(await tabB.getActiveExamAttempt()).toEqual(await tabA.getActiveExamAttempt())

      await tabA.discardActiveExamAttempt(running[0].examSessionId)
    }
  })

  it('four simultaneous starts over two connections: still exactly one running attempt', async () => {
    const { tabA, tabB } = await twoTabs()
    const attempts = await Promise.all([1, 2, 3, 4].map((seed) => prepared(seed % 2 ? tabA : tabB, seed)))
    const results = await Promise.all(attempts.map((attempt, index) => (index % 2 ? tabB : tabA).startExamAttempt(attempt)))

    expect(results.filter((result) => result.started)).toHaveLength(1)
    expect(results.filter((result) => result.reason === 'activeExists')).toHaveLength(3)
    expect(await tabA.listExamAttempts()).toHaveLength(1)
  })

  it('answer vs submit: the result always matches exactly what was stored, never a half state', async () => {
    const { tabA, tabB } = await twoTabs()
    for (let round = 0; round < 12; round++) {
      const started = await startedAttempt(tabA, { random: seededRandom(round + 1), now: 1000 })
      const id = started.orderedQuestionIds[0]
      const answer = { examSessionId: started.examSessionId, questionId: id, selectedOptionKey: correctKey(started, id) }
      // Abwechselnd andere Reihenfolge der Aufrufe, damit beide Interleavings vorkommen können.
      const [recorded, finalized] =
        round % 2
          ? (await Promise.all([tabB.finalizeExamAttempt(started.examSessionId, 5000), tabA.recordExamAnswer(answer)])).reverse()
          : await Promise.all([tabA.recordExamAnswer(answer), tabB.finalizeExamAttempt(started.examSessionId, 5000)])
      const stored = await tabA.getExamAttempt(started.examSessionId)
      const counted = recorded.recorded ? 1 : 0

      expect(finalized.finalized).toBe(true)

      if (!recorded.recorded) {
        expect(recorded.reason).toBe('submitted')
      }

      expect(stored.status).toBe('submitted')
      expect(Object.keys(stored.answers)).toHaveLength(counted)
      expect(stored.result).toMatchObject({ total: 20, correct: counted, incorrect: 0, unanswered: 20 - counted })
      expect(stored.result).toEqual(finalized.attempt.result)

      // Der abgegebene Versuch bleibt gespeichert (Abgegebenes ist unveränderlich); die nächste Runde startet einen neuen.
    }
  })

  it('submit vs submit across connections: one result, one completedAt, the other gets alreadySubmitted', async () => {
    const { tabA, tabB } = await twoTabs()
    const started = await startedAttempt(tabA)

    await tabA.recordExamAnswer({ examSessionId: started.examSessionId, questionId: started.orderedQuestionIds[0], selectedOptionKey: correctKey(started, started.orderedQuestionIds[0]) })

    const results = await Promise.all([
      tabA.finalizeExamAttempt(started.examSessionId, 7000),
      tabB.finalizeExamAttempt(started.examSessionId, 8000),
      tabB.finalizeExamAttempt(started.examSessionId, 9000),
    ])
    const winners = results.filter((result) => result.finalized)
    const stored = await tabA.getExamAttempt(started.examSessionId)

    expect(winners).toHaveLength(1)
    expect(results.filter((result) => result.reason === 'alreadySubmitted')).toHaveLength(2)
    expect(stored.completedAt).toBe(winners[0].attempt.completedAt)
    expect(stored.result.finalizedAt).toBe(stored.completedAt)
    expect(stored.result).toMatchObject({ correct: 1, unanswered: 19 })
    results.filter((result) => !result.finalized).forEach((result) => expect(result.attempt).toEqual(stored))
    expect(await tabB.listExamAttempts()).toHaveLength(1)
  })
})

describe('independent attempts', () => {
  it('runs a second attempt after the first one: other id and selection, first result untouched', async () => {
    const store = await readyStore()
    const first = await startedAttempt(store, { random: seededRandom(1) })

    await store.recordExamAnswer({ examSessionId: first.examSessionId, questionId: first.orderedQuestionIds[0], selectedOptionKey: correctKey(first, first.orderedQuestionIds[0]) })

    const { attempt: firstDone } = await store.finalizeExamAttempt(first.examSessionId, 3000)
    const second = await startedAttempt(store, { random: seededRandom(2), now: 4000 })

    expect(second.examSessionId).not.toBe(first.examSessionId)
    expect(second.orderedQuestionIds).not.toEqual(first.orderedQuestionIds)
    expect(second.answers).toEqual({})
    expect(await store.getExamAttempt(first.examSessionId)).toEqual(firstDone)
    expect((await store.getActiveExamAttempt()).examSessionId).toBe(second.examSessionId)
    expect((await store.listExamAttempts()).map((attempt) => attempt.examSessionId)).toEqual([second.examSessionId, first.examSessionId])

    await store.recordExamAnswer({ examSessionId: second.examSessionId, questionId: second.orderedQuestionIds[0], selectedOptionKey: 'a' })
    await store.finalizeExamAttempt(second.examSessionId, 5000)

    expect(await store.getExamAttempt(first.examSessionId)).toEqual(firstDone)
  })

  it('keeps a German and an English attempt independent', async () => {
    const store = await readyStore()
    const german = await startedAttempt(store, { language: 'de', random: seededRandom(3) })

    await store.finalizeExamAttempt(german.examSessionId, 2000)

    const english = await startedAttempt(store, { language: 'en', random: seededRandom(3), now: 3000 })
    const storedGerman = await store.getExamAttempt(german.examSessionId)

    expect(storedGerman.sessionLanguage).toBe('de')
    expect(english.sessionLanguage).toBe('en')
    expect(JSON.stringify(Object.values(storedGerman.questionSnapshots))).not.toContain('Synthetic explanation')
    expect(JSON.stringify(Object.values(english.questionSnapshots))).not.toContain('Synthetische Erklärung')
    expect(storedGerman.status).toBe('submitted')
    expect(english.status).toBe('inProgress')
  })
})

describe('isolation from learning data', () => {
  async function learningState(store) {
    return {
      progress: await store.listAllProgress(),
      sessions: await store.listSectionSessions(),
      libraryStates: await store.listLibraryStates(),
      contents: await Promise.all((await store.listLibraryStates()).map((state) => store.getLibraryContent(state.libraryId))),
      schema: await store.getStorageSchemaVersion(),
      retired: await store.getRetiredIndex(),
    }
  }

  it('start, answers, navigation, submit and discard write no progress, no session, no library data', async () => {
    const store = await readyStore()
    const { library, questions } = parseV2Library(makeExamLibraryData(SIZES)[0])

    // Vorhandener Lernstand: Progress, Lernrunde, Antwort-Ereignis.
    const learning = createSessionRecord({
      sessionId: 'learn-1',
      library,
      orderedQuestionIds: questions.map((question) => question.id),
      optionOrder: ['a', 'b', 'c', 'd'],
      now: 500,
    })

    await store.startNewSession(learning)
    await store.recordSessionAnswer({ sessionId: 'learn-1', libraryId: library.libraryId, questionId: questions[0].id, isCorrect: true, selectedOptionKey: 'a', answeredAt: 600 })

    const before = await learningState(store)
    const sessionBefore = await store.getLatestSession(library.libraryId)
    const attempt = await startedAttempt(store, { count: TOTAL, random: seededRandom(8) })

    for (const [index, id] of attempt.orderedQuestionIds.entries()) {
      await store.recordExamAnswer({ examSessionId: attempt.examSessionId, questionId: id, selectedOptionKey: index % 2 ? correctKey(attempt, id) : wrongKey(attempt, id) })
      await store.setExamPosition({ examSessionId: attempt.examSessionId, direction: 'next' })
    }

    await store.finalizeExamAttempt(attempt.examSessionId, 9000)
    await store.finalizeExamAttempt(attempt.examSessionId, 9001)

    expect(await learningState(store)).toEqual(before)
    expect(await store.getLatestSession(library.libraryId)).toEqual(sessionBefore)
    expect(await store.getQuestionProgress(library.libraryId, questions[0].id)).toMatchObject({ attempts: 1, correctCount: 1 })

    expect(await store.discardActiveExamAttempt(attempt.examSessionId)).toMatchObject({ discarded: false, reason: 'notActive' })
    expect(await learningState(store)).toEqual(before)
  })

  it('every exam store method opens only the examAttempts store', async () => {
    const store = await readyStore()
    const { pool, libraries } = await readExamPool(store)
    const opened = []
    const original = IDBDatabase.prototype.transaction

    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (names, mode) {
      opened.push([names].flat().join(','))
      return original.call(this, names, mode)
    })

    const attempt = createExamAttempt({ pool, libraries, count: 10, random: seededRandom(1) })
    const id = attempt.orderedQuestionIds[0]

    opened.length = 0
    await store.startExamAttempt(attempt)
    await store.getActiveExamAttempt()
    await store.listExamAttempts()
    await store.getExamAttempt(attempt.examSessionId)
    await store.recordExamAnswer({ examSessionId: attempt.examSessionId, questionId: id, selectedOptionKey: 'a' })
    await store.setExamPosition({ examSessionId: attempt.examSessionId, direction: 'next' })
    await store.finalizeExamAttempt(attempt.examSessionId)
    await store.discardActiveExamAttempt(attempt.examSessionId)

    expect(opened.length).toBeGreaterThanOrEqual(8)
    expect(new Set(opened)).toEqual(new Set(['examAttempts']))
  })

  it('no library update or replacement path opens the examAttempts store', async () => {
    const store = await readyStore()
    const opened = []
    const original = IDBDatabase.prototype.transaction
    const [v1] = makeExamLibraryData(SIZES)
    const v2 = makeExamLibraryData(SIZES, {
      overrides: { la01: { libraryVersion: '1.1.0', activeQuestionIndexHash: `sha256:${'d'.repeat(64)}`, contentRevisions: { 'sec-a01-0001': 2 } } },
    })[0]

    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (names, mode) {
      opened.push([names].flat().join(','))
      return original.call(this, names, mode)
    })

    const parsed = parseV2Library(v2)

    await applyLibraryUpdate(store, parsed.library, { questions: parsed.questions })
    await store.applyReplacementMigration({ libraryId: parseV2Library(v1).library.libraryId, replacements: [] })

    expect(opened.length).toBeGreaterThan(0)
    expect(opened.join(',')).not.toContain('examAttempts')
  })
})

describe('content update isolation', () => {
  // Alle 40 Fragen im Versuch, damit jede Änderung eine Frage des laufenden Versuchs trifft.
  async function runningFullAttempt(store, language = 'de') {
    const attempt = await startedAttempt(store, { count: TOTAL, language, random: seededRandom(21) })

    await store.recordExamAnswer({ examSessionId: attempt.examSessionId, questionId: attempt.orderedQuestionIds[0], selectedOptionKey: correctKey(attempt, attempt.orderedQuestionIds[0]) })
    await store.setExamPosition({ examSessionId: attempt.examSessionId, index: 3 })

    return store.getExamAttempt(attempt.examSessionId)
  }

  function changedLibrary(overrides, edit = () => {}) {
    const data = makeExamLibraryData(SIZES, { overrides: { la01: overrides } })[0]

    edit(data)

    return parseV2Library(data)
  }

  it('a library version / contentRevision / text / correct-key change does not touch a running attempt', async () => {
    const store = await readyStore()
    const running = await runningFullAttempt(store)
    const before = clone(running)
    const parsed = changedLibrary(
      { libraryVersion: '1.2.0', activeQuestionIndexHash: `sha256:${'e'.repeat(64)}`, contentRevisions: { 'sec-a01-0001': 2, 'sec-a01-0002': 3 } },
      (data) => {
        data.questions[0].localized.de.question = 'Völlig neuer Fragetext'
        data.questions[0].localized.de.explanation = 'Neue Erklärung'
        data.questions[0].localized.en.question = 'Completely new text'
        data.questions[0].correctOptionKey = data.questions[0].correctOptionKey === 'a' ? 'b' : 'a'
      },
    )

    const result = await applyLibraryUpdate(store, parsed.library, { questions: parsed.questions })

    expect(result.libraryState.libraryVersion).toBe('1.2.0')
    expect((await store.getLibraryContent('exam-lib-la01')).questions[0].question).toBe('Völlig neuer Fragetext')
    expect(await store.getExamAttempt(running.examSessionId)).toEqual(before)
    expect(await store.getActiveExamAttempt()).toEqual(before)
  })

  it('scoring and navigation keep using the snapshot after a contentRevision / correct-key update', async () => {
    const store = await readyStore()
    const running = await runningFullAttempt(store)
    const parsed = changedLibrary(
      { libraryVersion: '1.2.0', activeQuestionIndexHash: `sha256:${'e'.repeat(64)}`, contentRevisions: { 'sec-a01-0001': 2 } },
      (data) => {
        data.questions.forEach((question) => {
          question.correctOptionKey = question.correctOptionKey === 'a' ? 'b' : 'a'
        })
      },
    )

    await applyLibraryUpdate(store, parsed.library, { questions: parsed.questions })

    for (const id of running.orderedQuestionIds) {
      await store.recordExamAnswer({ examSessionId: running.examSessionId, questionId: id, selectedOptionKey: correctKey(running, id) })
    }

    const done = await store.finalizeExamAttempt(running.examSessionId, 8000)

    expect(done.attempt.result).toMatchObject({ total: TOTAL, correct: TOTAL, percent: 100 })
    expect(done.attempt.questionRevisions['sec-a01-0001']).toBe(1)
    expect(done.attempt.libraries.find((entry) => entry.libraryId === 'exam-lib-la01').libraryVersion).toBe('1.0.0')
  })

  it('a replacement (question retired, successor in another library) does not migrate or rewrite the attempt', async () => {
    const store = await readyStore()
    const running = await runningFullAttempt(store)
    const before = clone(running)
    const parsed = parseV2Library(
      makeExamLibraryData(SIZES, {
        overrides: { la01: { libraryVersion: '2.0.0', activeQuestionIndexHash: `sha256:${'c'.repeat(64)}`, omitIds: ['sec-a01-0012'] } },
      })[0],
    )
    const retiredIndex = parseRetiredIndex({ 'sec-a01-0012': { replacedBy: 'sec-a02-0001', progressMigration: 'reset', reason: 'synthetic' } })

    expect(running.orderedQuestionIds).toContain('sec-a01-0012')

    const result = await applyLibraryUpdate(store, parsed.library, { questions: parsed.questions, retiredIndex })

    expect(result.replacements).toHaveLength(1)
    expect(await store.getExamAttempt(running.examSessionId)).toEqual(before)

    const stored = await store.getExamAttempt(running.examSessionId)

    expect(stored.orderedQuestionIds).toContain('sec-a01-0012')
    expect(stored.questionSnapshots['sec-a01-0012']).toEqual(before.questionSnapshots['sec-a01-0012'])
    expect(stored.questionLibraries['sec-a01-0012']).toBe('exam-lib-la01')
    expect(JSON.stringify(stored)).not.toContain('replacedBy')
    expect(stored.answers).toEqual(before.answers)
  })

  it('a new attempt after the update uses the new library state, the finished one stays as it was', async () => {
    const store = await readyStore()
    const first = await runningFullAttempt(store)
    const { attempt: firstDone } = await store.finalizeExamAttempt(first.examSessionId, 3000)
    const parsed = changedLibrary(
      { libraryVersion: '1.3.0', activeQuestionIndexHash: `sha256:${'b'.repeat(64)}`, contentRevisions: { 'sec-a01-0001': 2 } },
      (data) => {
        data.questions.forEach((question) => {
          question.localized.de.question = `${question.localized.de.question} NEU`
        })
      },
    )

    await applyLibraryUpdate(store, parsed.library, { questions: parsed.questions })

    const second = await startedAttempt(store, { count: TOTAL, random: seededRandom(21), now: 4000 })

    expect(second.questionSnapshots['sec-a01-0001'].content.question).toContain('NEU')
    expect(second.questionRevisions['sec-a01-0001']).toBe(2)
    expect(second.libraries.find((entry) => entry.libraryId === 'exam-lib-la01').libraryVersion).toBe('1.3.0')
    expect(firstDone.questionSnapshots['sec-a01-0001'].content.question).not.toContain('NEU')
    expect(await store.getExamAttempt(first.examSessionId)).toEqual(firstDone)
  })

  it('library removal and re-import: the running attempt stays loadable, navigable and scorable', async () => {
    let store = await readyStore()
    const running = await runningFullAttempt(store, 'en')
    const before = clone(running)

    await rawDelete(dbName, ['libraries', 'libraryContent', 'progress'])
    expect(await store.listLibraryStates()).toEqual([])
    expect((await readExamPool(store)).pool).toEqual([])

    // Der Versuch ist komplett ohne Library bedienbar.
    store = await reopen(store)
    expect(await store.getActiveExamAttempt()).toEqual(before)
    expect(await store.setExamPosition({ examSessionId: running.examSessionId, direction: 'next' })).toMatchObject({ moved: true })
    expect((await store.recordExamAnswer({ examSessionId: running.examSessionId, questionId: running.orderedQuestionIds[10], selectedOptionKey: correctKey(running, running.orderedQuestionIds[10]) })).recorded).toBe(true)
    expect(presentExamQuestion(await store.getExamAttempt(running.examSessionId), running.orderedQuestionIds[10]).text).toContain('EN')

    // Re-Import mit anderem Inhalt (andere Texte, andere Lösungsschlüssel): ändert den Versuch nicht.
    const reimport = makeExamLibraryData(SIZES, { overrides: { la01: { questionLabel: 'Ganz andere Frage' } } })

    reimport.forEach((data) => data.questions.forEach((question) => {
      question.correctOptionKey = question.correctOptionKey === 'a' ? 'c' : 'a'
    }))
    await importExamLibraries(store, reimport, 9000)

    const stored = await store.getExamAttempt(running.examSessionId)

    expect(stored.questionSnapshots).toEqual(before.questionSnapshots)
    expect(stored.orderedQuestionIds).toEqual(before.orderedQuestionIds)

    for (const id of running.orderedQuestionIds) {
      await store.recordExamAnswer({ examSessionId: running.examSessionId, questionId: id, selectedOptionKey: correctKey(running, id) })
    }

    expect((await store.finalizeExamAttempt(running.examSessionId, 9500)).attempt.result).toMatchObject({ correct: TOTAL, percent: 100 })
  })

  it('a completed attempt survives library removal unchanged', async () => {
    const store = await readyStore()
    const running = await runningFullAttempt(store)
    const { attempt: done } = await store.finalizeExamAttempt(running.examSessionId, 3000)

    await rawDelete(dbName, ['libraries', 'libraryContent', 'progress', 'sessions'])

    expect(await store.getExamAttempt(running.examSessionId)).toEqual(done)
  })
})

describe('privacy', () => {
  it('makes no network call while starting, answering, submitting and reading an attempt', async () => {
    const fetchSpy = vi.fn()
    const beacon = vi.fn()
    const xhrSend = vi.fn()

    vi.stubGlobal('fetch', fetchSpy)
    if (typeof XMLHttpRequest !== 'undefined') {
      vi.spyOn(XMLHttpRequest.prototype, 'send').mockImplementation(xhrSend)
    }
    vi.stubGlobal('navigator', { ...globalThis.navigator, sendBeacon: beacon })

    const store = await readyStore()
    const attempt = await startedAttempt(store)
    const id = attempt.orderedQuestionIds[0]

    await store.recordExamAnswer({ examSessionId: attempt.examSessionId, questionId: id, selectedOptionKey: 'a' })
    await store.setExamPosition({ examSessionId: attempt.examSessionId, direction: 'next' })
    await store.finalizeExamAttempt(attempt.examSessionId)
    await store.listExamAttempts()

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(beacon).not.toHaveBeenCalled()
    expect(xhrSend).not.toHaveBeenCalled()
  })
})
