import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createProgressStore, STORAGE_SCHEMA_VERSION } from '../src/storage/progressStore.js'
import { createSessionRecord } from '../src/domain/session.js'
import { parseV2Library } from '../src/lib/library/parseLibrary.js'
import { makeSyntheticLibrary } from './fixtures/syntheticLibrary.js'

let dbName
let openStores

function openStore(name = dbName) {
  const store = createProgressStore({ dbName: name })
  openStores.push(store)
  return store
}

function rawCount(name, storeName) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name)
    request.onsuccess = () => {
      const database = request.result
      const countRequest = database.transaction(storeName).objectStore(storeName).count()
      countRequest.onsuccess = () => {
        database.close()
        resolve(countRequest.result)
      }
    }
    request.onerror = () => reject(request.error)
  })
}

function makeSession(libraryId = 'session-lib', sessionId = 'session-1', count = 4, now = 1000) {
  const { library, questions } = parseV2Library(makeSyntheticLibrary({ libraryId, count }))
  const ids = questions.map((question) => question.id).reverse()

  return {
    ids,
    session: createSessionRecord({ sessionId, library, orderedQuestionIds: ids, optionOrder: ['a', 'b', 'c', 'd'], now }),
  }
}

beforeEach(() => {
  dbName = `session-db-${Math.random().toString(36).slice(2)}`
  openStores = []
})

afterEach(() => openStores.forEach((store) => store.close()))

describe('session store', () => {
  it('persists order, current question id and index across reloads (also repeated)', async () => {
    const { session, ids } = makeSession()
    const first = openStore()
    await first.initialize()
    await first.startNewSession(session)
    await first.advanceSessionTo({ sessionId: 'session-1', questionId: ids[1], optionOrder: ['b', 'a', 'd', 'c'] })
    first.close()

    for (let reload = 0; reload < 3; reload++) {
      const store = openStore()
      await store.initialize()
      const stored = await store.getLatestSession('session-lib')

      expect(stored.orderedQuestionIds).toEqual(ids)
      expect(stored.currentQuestionId).toBe(ids[1])
      expect(stored.currentIndex).toBe(1)
      expect(stored.currentQuestionState.optionOrder).toEqual(['b', 'a', 'd', 'c'])
      store.close()
    }
  })

  it('writes progress and session state together and counts each question once', async () => {
    const { session, ids } = makeSession()
    const store = openStore()
    await store.initialize()
    await store.startNewSession(session)

    const answer = { sessionId: 'session-1', libraryId: 'session-lib', questionId: ids[0], isCorrect: true, selectedOptionKey: 'c' }
    const first = await store.recordSessionAnswer(answer)
    const repeated = await store.recordSessionAnswer(answer)

    expect(first.recorded).toBe(true)
    expect(repeated).toEqual({ recorded: false, reason: 'duplicate' })
    expect(await store.getQuestionProgress('session-lib', ids[0])).toMatchObject({ attempts: 1, correctCount: 1 })
    expect(await store.getLatestSession('session-lib')).toMatchObject({
      answeredQuestionIds: [ids[0]],
      sessionCorrectCount: 1,
      sessionIncorrectCount: 0,
      currentQuestionId: ids[0],
      currentQuestionState: { selectedOptionKey: 'c', isCorrect: true },
    })
  })

  it('writes nothing for an unknown session or question (all-or-nothing)', async () => {
    const { session, ids } = makeSession()
    const store = openStore()
    await store.initialize()
    await store.startNewSession(session)

    const noSession = await store.recordSessionAnswer({
      sessionId: 'missing', libraryId: 'session-lib', questionId: ids[0], isCorrect: true,
    })
    const unknown = await store.recordSessionAnswer({
      sessionId: 'session-1', libraryId: 'session-lib', questionId: 'sec-a30-9999', isCorrect: true,
    })

    expect(noSession.reason).toBe('noSession')
    expect(unknown.reason).toBe('unknownQuestion')
    expect(await store.listProgressForLibrary('session-lib')).toEqual([])
    expect((await store.getLatestSession('session-lib')).answeredQuestionIds).toEqual([])
  })

  it('keeps the answered question after reload without a double count', async () => {
    const { session, ids } = makeSession()
    const store = openStore()
    await store.initialize()
    await store.startNewSession(session)
    await store.recordSessionAnswer({ sessionId: 'session-1', libraryId: 'session-lib', questionId: ids[0], isCorrect: false, selectedOptionKey: 'a' })
    store.close()

    const reloaded = openStore()
    await reloaded.initialize()
    const stored = await reloaded.getLatestSession('session-lib')

    expect(stored).toMatchObject({ sessionIncorrectCount: 1, answeredQuestionIds: [ids[0]], currentQuestionId: ids[0], currentIndex: 0 })
    expect((await reloaded.getQuestionProgress('session-lib', ids[0])).attempts).toBe(1)
  })

  it('marks a session completed and resumed', async () => {
    const { session } = makeSession()
    const store = openStore()
    await store.initialize()
    await store.startNewSession(session)
    await store.markSessionResumed('session-1', 4000)
    await store.completeSessionById('session-1', 5000)

    expect(await store.getLatestSession('session-lib')).toMatchObject({
      completed: true, completedAt: 5000, lastResumedAt: 4000,
    })
  })

  it('a new round replaces the session but never deletes lifetime progress', async () => {
    const { session, ids } = makeSession('session-lib', 'round-1')
    const store = openStore()
    await store.initialize()
    await store.startNewSession(session)
    await store.recordSessionAnswer({ sessionId: 'round-1', libraryId: 'session-lib', questionId: ids[0], isCorrect: true })
    await store.completeSessionById('round-1')

    const next = makeSession('session-lib', 'round-2', 4, 9000)
    await store.startNewSession(next.session)

    expect(await rawCount(dbName, 'sessions')).toBe(1)
    const latest = await store.getLatestSession('session-lib')

    expect(latest).toMatchObject({ sessionId: 'round-2', completed: false, answeredQuestionIds: [], sessionCorrectCount: 0 })
    // Lebenszeit-Progress bleibt, die neue Runde zählt bei 0 (Session ≠ Lifetime).
    expect(await store.getQuestionProgress('session-lib', ids[0])).toMatchObject({ attempts: 1, correctCount: 1 })
    await store.recordSessionAnswer({ sessionId: 'round-2', libraryId: 'session-lib', questionId: ids[0], isCorrect: true })
    expect(await store.getQuestionProgress('session-lib', ids[0])).toMatchObject({ attempts: 2 })
    expect((await store.getLatestSession('session-lib')).answeredQuestionIds).toEqual([ids[0]])
  })

  it('keeps separate sessions for separate libraries', async () => {
    const store = openStore()
    await store.initialize()
    await store.startNewSession(makeSession('library-one', 'one').session)
    await store.startNewSession(makeSession('library-two', 'two').session)

    expect(await rawCount(dbName, 'sessions')).toBe(2)
    expect((await store.getLatestSession('library-one')).sessionId).toBe('one')
    expect((await store.getLatestSession('library-two')).sessionId).toBe('two')
    expect(await store.getLatestSession('library-three')).toBeNull()
  })

  it('rejects an invalid advance without changing the stored session', async () => {
    const { session } = makeSession()
    const store = openStore()
    await store.initialize()
    await store.startNewSession(session)

    await expect(store.advanceSessionTo({ sessionId: 'session-1', questionId: 'sec-a30-9999' })).rejects.toThrow()
    expect(await store.getLatestSession('session-lib')).toEqual(session)
  })
})

describe('storage upgrade from Phase 2A', () => {
  it('adds the sessions store additively and keeps data and storageSchemaVersion 1', async () => {
    // DB im Phase-2A-Zustand (DB_VERSION 1, ohne sessions-Store) mit Daten anlegen.
    await new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, 1)
      request.onupgradeneeded = () => {
        const database = request.result
        database.createObjectStore('meta', { keyPath: 'key' }).put({ key: 'storageSchemaVersion', value: 1 })
        database.createObjectStore('libraries', { keyPath: 'libraryId' }).put({
          libraryId: 'old-lib', libraryVersion: '1.0.0', activeQuestionIndexHash: `sha256:${'a'.repeat(64)}`, firstImportedAt: 1, lastAccessedAt: 1,
        })
        const progress = database.createObjectStore('progress', { keyPath: ['libraryId', 'questionId'] })
        progress.createIndex('byLibrary', 'libraryId')
        progress.put({ libraryId: 'old-lib', questionId: 'sec-a30-0001', attempts: 3, correctCount: 2, incorrectCount: 1, lastResult: 'correct', answered: true, lastAnsweredAt: 5 })
      }
      request.onsuccess = () => { request.result.close(); resolve() }
      request.onerror = () => reject(request.error)
    })

    const store = openStore()
    await store.initialize()

    expect(await store.getStorageSchemaVersion()).toBe(STORAGE_SCHEMA_VERSION)
    expect(STORAGE_SCHEMA_VERSION).toBe(1)
    expect(await store.getQuestionProgress('old-lib', 'sec-a30-0001')).toMatchObject({ attempts: 3 })
    expect(await store.getLibraryState('old-lib')).toMatchObject({ libraryVersion: '1.0.0' })
    expect(await store.getLatestSession('old-lib')).toBeNull()
  })
})
