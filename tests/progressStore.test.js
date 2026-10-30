import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createProgressStore,
  DB_VERSION,
  StorageSchemaError,
  STORAGE_SCHEMA_VERSION,
} from '../src/storage/progressStore.js'
import { IMPORT_STATUS, registerLibraryImport } from '../src/storage/libraryImport.js'
import { summarizeLibraryProgress } from '../src/domain/progressSummary.js'
import { makeSyntheticLibrary } from './fixtures/syntheticLibrary.js'
import { parseV2Library } from '../src/lib/library/parseLibrary.js'

const HASH_A = `sha256:${'a'.repeat(64)}`
const HASH_B = `sha256:${'b'.repeat(64)}`

let dbName
let openStores

function openStore() {
  const store = createProgressStore({ dbName })
  openStores.push(store)
  return store
}

function rawOpen(name, version) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('meta')) {
        request.result.createObjectStore('meta', { keyPath: 'key' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
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

beforeEach(() => {
  dbName = `test-db-${Math.random().toString(36).slice(2)}`
  openStores = []
})

afterEach(() => {
  openStores.forEach((store) => store.close())
})

describe('storage initialization', () => {
  it('writes storageSchemaVersion 1 on first start, separate from the DB version', async () => {
    const store = openStore()
    await store.initialize()

    expect(await store.getStorageSchemaVersion()).toBe(1)
    expect(STORAGE_SCHEMA_VERSION).toBe(1)
    expect(DB_VERSION).toBe(1)
  })

  it('rejects an unknown storageSchemaVersion in a controlled way', async () => {
    const first = openStore()
    await first.initialize()
    first.close()

    const raw = await rawOpen(dbName, DB_VERSION)
    const transaction = raw.transaction('meta', 'readwrite')
    transaction.objectStore('meta').put({ key: 'storageSchemaVersion', value: 99 })
    await new Promise((resolve) => (transaction.oncomplete = resolve))
    raw.close()

    const second = openStore()

    await expect(second.initialize()).rejects.toBeInstanceOf(StorageSchemaError)
    await expect(second.getLibraryState('any-library')).rejects.toThrow()
  })

  it('rejects a database created by a newer DB version', async () => {
    const raw = await rawOpen(dbName, DB_VERSION + 4)
    raw.close()

    await expect(openStore().initialize()).rejects.toBeInstanceOf(StorageSchemaError)
  })
})

describe('library import', () => {
  let store

  beforeEach(async () => {
    store = openStore()
    await store.initialize()
  })

  it('first import creates the library state and no question progress', async () => {
    const { library } = parseV2Library(makeSyntheticLibrary({ libraryVersion: '1.0.1' }))
    const result = await registerLibraryImport(store, library, { now: 1000 })

    expect(result.status).toBe(IMPORT_STATUS.NEW)
    expect(await store.getLibraryState(library.libraryId)).toEqual({
      libraryId: library.libraryId,
      libraryVersion: '1.0.1',
      activeQuestionIndexHash: HASH_A,
      firstImportedAt: 1000,
      lastAccessedAt: 1000,
    })
    expect(await store.listProgressForLibrary(library.libraryId)).toEqual([])
  })

  it('first import does not touch progress of another library', async () => {
    await store.recordAnswer({ libraryId: 'other-library', questionId: 'sec-a30-0001', isCorrect: true })
    const { library } = parseV2Library(makeSyntheticLibrary())

    await registerLibraryImport(store, library)

    expect(await store.listProgressForLibrary('other-library')).toHaveLength(1)
  })

  it('an unknown libraryId creates a separate library state', async () => {
    const first = parseV2Library(makeSyntheticLibrary({ libraryId: 'library-one' })).library
    const second = parseV2Library(makeSyntheticLibrary({ libraryId: 'library-two' })).library

    await registerLibraryImport(store, first)
    await store.recordAnswer({ libraryId: 'library-one', questionId: 'sec-a30-0001', isCorrect: false })
    const result = await registerLibraryImport(store, second)

    expect(result.status).toBe(IMPORT_STATUS.NEW)
    expect(await rawCount(dbName, 'libraries')).toBe(2)
    expect(await store.listProgressForLibrary('library-one')).toHaveLength(1)
    expect(await store.listProgressForLibrary('library-two')).toHaveLength(0)
  })

  it('repeated import with same version and hash keeps progress and the single state', async () => {
    const { library } = parseV2Library(makeSyntheticLibrary())

    await registerLibraryImport(store, library, { now: 1000 })
    await store.recordAnswer({ libraryId: library.libraryId, questionId: 'sec-a30-0001', isCorrect: true })
    const result = await registerLibraryImport(store, library, { now: 2000 })

    expect(result.status).toBe(IMPORT_STATUS.KNOWN)
    expect(await rawCount(dbName, 'libraries')).toBe(1)
    expect(await store.getLibraryState(library.libraryId)).toMatchObject({
      firstImportedAt: 1000,
      lastAccessedAt: 2000,
    })
    expect(await store.listProgressForLibrary(library.libraryId)).toHaveLength(1)
  })

  it('same libraryId, other version, same hash keeps progress', async () => {
    const v100 = parseV2Library(makeSyntheticLibrary({ libraryVersion: '1.0.0' })).library
    const v101 = parseV2Library(makeSyntheticLibrary({ libraryVersion: '1.0.1' })).library

    await registerLibraryImport(store, v100)
    await store.recordAnswer({ libraryId: v100.libraryId, questionId: 'sec-a30-0001', isCorrect: true })
    const result = await registerLibraryImport(store, v101)

    expect(result.status).toBe(IMPORT_STATUS.VERSION_UPDATED)
    expect((await store.getLibraryState(v100.libraryId)).libraryVersion).toBe('1.0.1')
    expect(await store.listProgressForLibrary(v100.libraryId)).toHaveLength(1)

    const older = await registerLibraryImport(store, v100)

    expect(older.status).toBe(IMPORT_STATUS.KNOWN)
    expect((await store.getLibraryState(v100.libraryId)).libraryVersion).toBe('1.0.1')
  })

  it('same libraryId with another hash is not silently accepted or migrated', async () => {
    const original = parseV2Library(makeSyntheticLibrary({ libraryVersion: '1.0.0' })).library
    await registerLibraryImport(store, original, { now: 1000 })
    await store.recordAnswer({ libraryId: original.libraryId, questionId: 'sec-a30-0001', isCorrect: true })

    for (const libraryVersion of ['1.0.0', '1.1.0', '0.9.0']) {
      const changed = parseV2Library(
        makeSyntheticLibrary({ libraryVersion, activeQuestionIndexHash: HASH_B }),
      ).library
      const result = await registerLibraryImport(store, changed, { now: 5000 })

      expect(result.status).toBe(IMPORT_STATUS.UPDATE_REQUIRES_MIGRATION)
    }

    expect(await store.getLibraryState(original.libraryId)).toEqual({
      libraryId: original.libraryId,
      libraryVersion: '1.0.0',
      activeQuestionIndexHash: HASH_A,
      firstImportedAt: 1000,
      lastAccessedAt: 1000,
    })
    expect(await store.listProgressForLibrary(original.libraryId)).toHaveLength(1)
  })
})

describe('question progress', () => {
  let store

  beforeEach(async () => {
    store = openStore()
    await store.initialize()
  })

  it('an answer creates progress keyed by libraryId and question.id', async () => {
    expect(await store.getQuestionProgress('lib-a', 'sec-a30-0001')).toBeNull()

    const record = await store.recordAnswer({
      libraryId: 'lib-a',
      questionId: 'sec-a30-0001',
      isCorrect: true,
      answeredAt: 4242,
    })

    expect(record).toEqual({
      libraryId: 'lib-a',
      questionId: 'sec-a30-0001',
      attempts: 1,
      correctCount: 1,
      incorrectCount: 0,
      lastResult: 'correct',
      answered: true,
      lastAnsweredAt: 4242,
    })
    expect(await store.getQuestionProgress('lib-a', 'sec-a30-0001')).toEqual(record)
    expect(await store.getQuestionProgress('lib-b', 'sec-a30-0001')).toBeNull()
  })

  it('counts correct and incorrect answers and increments attempts', async () => {
    const key = { libraryId: 'lib-a', questionId: 'sec-a30-0002' }

    await store.recordAnswer({ ...key, isCorrect: false })
    await store.recordAnswer({ ...key, isCorrect: false })
    const last = await store.recordAnswer({ ...key, isCorrect: true })

    expect(last).toMatchObject({ attempts: 3, correctCount: 1, incorrectCount: 2, lastResult: 'correct' })

    const wrongAgain = await store.recordAnswer({ ...key, isCorrect: false })

    expect(wrongAgain).toMatchObject({ attempts: 4, correctCount: 1, incorrectCount: 3, lastResult: 'incorrect' })
  })

  it('does not lose counts when answers are recorded concurrently', async () => {
    const key = { libraryId: 'lib-a', questionId: 'sec-a30-0003' }

    await Promise.all([
      store.recordAnswer({ ...key, isCorrect: true }),
      store.recordAnswer({ ...key, isCorrect: false }),
      store.recordAnswer({ ...key, isCorrect: true }),
    ])

    expect(await store.getQuestionProgress(key.libraryId, key.questionId)).toMatchObject({
      attempts: 3,
      correctCount: 2,
      incorrectCount: 1,
    })
  })

  it('keeps progress, library state and counts across a simulated reload', async () => {
    const { library } = parseV2Library(makeSyntheticLibrary())
    await registerLibraryImport(store, library, { now: 1000 })
    await store.recordAnswer({ libraryId: library.libraryId, questionId: 'sec-a30-0001', isCorrect: true })
    await store.recordAnswer({ libraryId: library.libraryId, questionId: 'sec-a30-0002', isCorrect: false })
    store.close()

    const reloaded = openStore()
    await reloaded.initialize()

    expect(await reloaded.getLibraryState(library.libraryId)).toMatchObject({ libraryVersion: '1.0.0' })
    const records = await reloaded.listProgressForLibrary(library.libraryId)

    expect(records.map((record) => [record.questionId, record.lastResult, record.answered, record.attempts])).toEqual([
      ['sec-a30-0001', 'correct', true, 1],
      ['sec-a30-0002', 'incorrect', true, 1],
    ])
  })

  it('upsertQuestionProgress and upsertLibraryState round-trip', async () => {
    const progress = {
      libraryId: 'lib-a',
      questionId: 'sec-a30-0004',
      attempts: 2,
      correctCount: 1,
      incorrectCount: 1,
      lastResult: 'incorrect',
      answered: true,
      lastAnsweredAt: 7,
    }
    const state = {
      libraryId: 'lib-a',
      libraryVersion: '1.2.3',
      activeQuestionIndexHash: HASH_A,
      firstImportedAt: 1,
      lastAccessedAt: 2,
    }

    await store.upsertQuestionProgress(progress)
    await store.upsertLibraryState(state)

    expect(await store.getQuestionProgress('lib-a', 'sec-a30-0004')).toEqual(progress)
    expect(await store.getLibraryState('lib-a')).toEqual(state)
  })
})

describe('progress summary', () => {
  it('derives statistics only from raw data of active questions', async () => {
    const { questions } = parseV2Library(makeSyntheticLibrary({ count: 4 }))
    const records = [
      { libraryId: 'x', questionId: questions[0].id, attempts: 2, lastResult: 'correct', answered: true },
      { libraryId: 'x', questionId: questions[1].id, attempts: 1, lastResult: 'incorrect', answered: true },
      { libraryId: 'x', questionId: 'sec-a30-9999', attempts: 5, lastResult: 'correct', answered: true },
    ]

    const summary = summarizeLibraryProgress(questions, records)

    expect(summary).toMatchObject({
      totalQuestions: 4,
      answeredCount: 2,
      lastCorrectCount: 1,
      lastIncorrectCount: 1,
      totalAttempts: 3,
    })
    expect(summary.categories).toEqual([
      { name: 'la99.alpha', total: 2, answered: 1, lastCorrect: 1 },
      { name: 'la99.beta', total: 2, answered: 1, lastCorrect: 0 },
    ])
  })
})
