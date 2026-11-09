import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProgressStore, DB_VERSION } from '../src/storage/progressStore.js'
import { confirmPendingUpdate, importLibraryBatch } from '../src/storage/catalogImport.js'
import { BATCH_STATUS } from '../src/domain/libraryCatalog.js'
import {
  formatImportDate,
  isCompleteCleanRefresh,
  isSuccessfulLibraryImport,
  LIBRARY_REFRESH_INTERVAL_DAYS,
  LIBRARY_REFRESH_INTERVAL_MS,
  libraryRefreshState,
  loadLibraryRefresh,
  noteLibraryImport,
  REFRESH_ORIGIN,
  requestPersistentStorage,
} from '../src/storage/libraryRefresh.js'
import { parseQuestionFile } from '../src/lib/library/parseLibrary.js'
import { makeSyntheticLibrary } from './fixtures/syntheticLibrary.js'

const DAY = 24 * 60 * 60 * 1000
const T0 = Date.UTC(2026, 10, 9, 12, 0, 0)

let dbName
let stores

beforeEach(() => {
  dbName = `refresh-db-${Math.random().toString(36).slice(2)}`
  stores = []
})

afterEach(() => stores.forEach((store) => store.close()))

async function newStore() {
  const store = createProgressStore({ dbName })

  stores.push(store)
  await store.initialize()

  return store
}

const entry = () => {
  const data = makeSyntheticLibrary({ libraryId: 'lib-refresh', learningSectionId: 'la01', idPrefix: 'sec-a01', count: 3 })

  return { fileName: 'lib-refresh.json', kind: 'v2', ...parseQuestionFile(data) }
}

describe('30-day rule (pure)', () => {
  it('names the interval as one constant', () => {
    expect(LIBRARY_REFRESH_INTERVAL_DAYS).toBe(30)
    expect(LIBRARY_REFRESH_INTERVAL_MS).toBe(30 * DAY)
  })

  it.each([
    ['0 days', 0, false],
    ['29 days', 29 * DAY, false],
    ['30 days minus 1 ms', 30 * DAY - 1, false],
    ['exactly 30 days', 30 * DAY, true],
    ['30 days plus 1 ms', 30 * DAY + 1, true],
    ['31 days', 31 * DAY, true],
    ['365 days', 365 * DAY, true],
  ])('is due: %s', (_label, age, due) => {
    expect(libraryRefreshState({ importedAt: T0, now: T0 + age, hasLibraries: true }).due).toBe(due)
  })

  it('reports whole elapsed days', () => {
    expect(libraryRefreshState({ importedAt: T0, now: T0 + 30 * DAY, hasLibraries: true }).ageDays).toBe(30)
    expect(libraryRefreshState({ importedAt: T0, now: T0 + 31 * DAY + 5 * 3600 * 1000, hasLibraries: true }).ageDays).toBe(31)
  })

  const UNKNOWN = { importedAt: null, origin: null, ageDays: null, due: false }

  it('is never due without libraries or without a valid timestamp', () => {
    expect(libraryRefreshState({ importedAt: T0, now: T0 + 90 * DAY, hasLibraries: false })).toEqual(UNKNOWN)
    expect(libraryRefreshState({ importedAt: null, now: T0, hasLibraries: true })).toEqual(UNKNOWN)
    expect(libraryRefreshState({ importedAt: 'gestern', now: T0, hasLibraries: true })).toEqual(UNKNOWN)
    expect(libraryRefreshState({ importedAt: NaN, now: T0, hasLibraries: true })).toEqual(UNKNOWN)
  })

  it('treats a timestamp in the future as unsafe (unknown), but "now" itself is valid', () => {
    expect(libraryRefreshState({ importedAt: T0, now: T0, hasLibraries: true })).toMatchObject({ importedAt: T0, ageDays: 0, due: false })
    expect(libraryRefreshState({ importedAt: T0 + 1, now: T0, hasLibraries: true })).toEqual(UNKNOWN)
    expect(libraryRefreshState({ importedAt: T0 + 60 * 1000, now: T0, hasLibraries: true })).toEqual(UNKNOWN)
    expect(libraryRefreshState({ importedAt: T0 + DAY, now: T0, hasLibraries: true })).toEqual(UNKNOWN)
    expect(libraryRefreshState({ importedAt: T0 + 400 * DAY, now: T0, hasLibraries: true })).toEqual(UNKNOWN)
  })

  it('keeps the origin and reads a missing origin conservatively as baseline', () => {
    expect(libraryRefreshState({ importedAt: T0, origin: REFRESH_ORIGIN.IMPORT, now: T0, hasLibraries: true }).origin).toBe('import')
    expect(libraryRefreshState({ importedAt: T0, origin: REFRESH_ORIGIN.BASELINE, now: T0, hasLibraries: true }).origin).toBe('baseline')
    expect(libraryRefreshState({ importedAt: T0, now: T0, hasLibraries: true }).origin).toBe('baseline')
    expect(libraryRefreshState({ importedAt: T0, origin: 'etwas', now: T0, hasLibraries: true }).origin).toBe('baseline')
  })
})

describe('stored library import (reason to ask for persistent storage)', () => {
  it.each([
    [BATCH_STATUS.NEW, true],
    [BATCH_STATUS.KNOWN, true],
    [BATCH_STATUS.VERSION_UPDATED, true],
    [BATCH_STATUS.UPDATE_PENDING, false],
    [BATCH_STATUS.REPLACEMENT_PENDING, false],
    [BATCH_STATUS.UPDATE_BLOCKED, false],
    [BATCH_STATUS.INVALID, false],
    [BATCH_STATUS.REJECTED, false],
    [BATCH_STATUS.SKIPPED, false],
  ])('%s', (status, expected) => {
    expect(isSuccessfulLibraryImport([{ fileName: 'a.json', libraryId: 'lib-a', status }])).toBe(expected)
  })

  it('ignores the retired index and results without a library, one good library is enough for this purpose', () => {
    expect(isSuccessfulLibraryImport([{ fileName: 'retired-index.json', status: 'retiredIndexLoaded' }])).toBe(false)
    expect(isSuccessfulLibraryImport([])).toBe(false)
    expect(
      isSuccessfulLibraryImport([
        { fileName: 'kaputt.json', status: BATCH_STATUS.INVALID },
        { fileName: 'a.json', libraryId: 'lib-a', status: BATCH_STATUS.NEW },
      ]),
    ).toBe(true)
  })
})

describe('timestamp in the existing meta store', () => {
  it('stores the timestamp without a schema change and keeps it across store instances', async () => {
    const first = await newStore()

    expect(DB_VERSION).toBe(4)
    expect(await first.getLastLibraryImportAt()).toBeNull()
    await first.recordLibraryImport(T0)
    first.close()

    const second = await newStore()

    expect(await second.getLastLibraryImportAt()).toBe(T0)
    expect(await second.getStorageSchemaVersion()).toBe(1)
  })

  it('records the time after a successful batch and leaves it alone after a failed one', async () => {
    const store = await newStore()
    const batch = await importLibraryBatch(store, [entry()], { now: T0 })

    expect(await noteLibraryImport(store, batch.results, { now: T0 })).toBe(true)
    expect(await store.getLastLibraryImportAt()).toBe(T0)
    expect(await noteLibraryImport(store, [{ fileName: 'kaputt.json', status: BATCH_STATUS.INVALID }], { now: T0 + 40 * DAY })).toBe(false)
    expect(await store.getLastLibraryImportAt()).toBe(T0)
    expect(await noteLibraryImport(store, [{ fileName: 'a.json', libraryId: 'lib-refresh', status: BATCH_STATUS.KNOWN }], { now: T0 + 40 * DAY })).toBe(true)
    expect(await store.getLastLibraryImportAt()).toBe(T0 + 40 * DAY)
  })

  it('does not let a failing write break the import', async () => {
    const failing = { recordLibraryImport: vi.fn().mockRejectedValue(new Error('quota')) }

    await expect(noteLibraryImport(failing, [{ libraryId: 'lib-a', status: BATCH_STATUS.NEW }])).resolves.toBe(false)
  })
})

describe('start: load and legacy baseline', () => {
  it('has nothing to remind about without libraries and writes no timestamp', async () => {
    const store = await newStore()

    expect(await loadLibraryRefresh(store, { now: T0 + 90 * DAY })).toEqual({ importedAt: null, origin: null, ageDays: null, due: false })
    expect(await store.getLastLibraryImportAt()).toBeNull()
  })

  it('gives stored libraries without a timestamp a baseline instead of an immediate reminder', async () => {
    const store = await newStore()

    await importLibraryBatch(store, [entry()], { now: T0 })

    expect(await store.getLastLibraryImportAt()).toBeNull()
    expect(await loadLibraryRefresh(store, { now: T0 + 100 * DAY })).toEqual({ importedAt: T0 + 100 * DAY, origin: 'baseline', ageDays: 0, due: false })
    expect(await store.getLastLibraryImportAt()).toBe(T0 + 100 * DAY)
    expect((await store.getLibraryImportRecord()).origin).toBe('baseline')
    // Der Basiswert bleibt: die Erinnerung beginnt 30 Tage danach, nicht bei jedem Start neu.
    expect((await loadLibraryRefresh(store, { now: T0 + 129 * DAY })).due).toBe(false)
    expect((await loadLibraryRefresh(store, { now: T0 + 130 * DAY })).due).toBe(true)
  })

  it('treats a damaged timestamp like a missing one', async () => {
    const store = await newStore()

    await importLibraryBatch(store, [entry()], { now: T0 })
    await store.recordLibraryImport('kaputt')

    expect(await loadLibraryRefresh(store, { now: T0 + 50 * DAY })).toMatchObject({ importedAt: T0 + 50 * DAY, due: false })
  })

  it('never touches libraries, progress or exam attempts', async () => {
    const store = await newStore()

    await importLibraryBatch(store, [entry()], { now: T0 })

    const before = JSON.stringify([await store.listLibraryStates(), await store.listAllProgress(), await store.listExamAttempts()])

    await loadLibraryRefresh(store, { now: T0 + 400 * DAY })
    expect(JSON.stringify([await store.listLibraryStates(), await store.listAllProgress(), await store.listExamAttempts()])).toBe(before)
  })
})

describe('date display', () => {
  it('formats the date per language', () => {
    const local = new Date(2026, 10, 9, 12).getTime()

    expect(formatImportDate(local, 'de')).toBe('09.11.2026')
    expect(formatImportDate(local, 'en')).toBe('Nov 9, 2026')
  })
})

describe('persistent storage request (best effort)', () => {
  it('does nothing without browser support', async () => {
    expect(await requestPersistentStorage(undefined)).toBeNull()
    expect(await requestPersistentStorage({})).toBeNull()
  })

  it('asks once and does not ask again when the data is already persistent', async () => {
    const ask = { persisted: vi.fn().mockResolvedValue(false), persist: vi.fn().mockResolvedValue(true) }

    expect(await requestPersistentStorage(ask)).toBe(true)
    expect(ask.persist).toHaveBeenCalledTimes(1)

    const already = { persisted: vi.fn().mockResolvedValue(true), persist: vi.fn() }

    expect(await requestPersistentStorage(already)).toBe(true)
    expect(already.persist).not.toHaveBeenCalled()
  })

  it('accepts a refusal and survives errors', async () => {
    expect(await requestPersistentStorage({ persist: vi.fn().mockResolvedValue(false) })).toBe(false)
    expect(await requestPersistentStorage({ persist: vi.fn().mockRejectedValue(new Error('no')) })).toBeNull()
  })
})

// --- Fix 1: globaler Zeitpunkt nur nach vollständigem, sauberem Refresh -----------------------------------------------

const COUNT = 24
const hex = (index) => `sha256:${index.toString(16).padStart(2, '0').repeat(32)}`
const rawLibrary = (index, options = {}) =>
  makeSyntheticLibrary({
    libraryId: `lib-refresh-${String(index).padStart(2, '0')}`,
    learningSectionId: `la0${(index % 9) + 1}`,
    idPrefix: `sec-a${String(index + 1).padStart(2, '0')}`,
    count: 2,
    activeQuestionIndexHash: hex(index + 1),
    ...options,
  })
const entryOf = (data) => ({ fileName: `${data.libraryId}.json`, kind: 'v2', ...parseQuestionFile(data) })
const ORIGINALS = Array.from({ length: COUNT }, (_, index) => rawLibrary(index))
const entries = (count = COUNT) => ORIGINALS.slice(0, count).map(entryOf)
const invalidEntry = { fileName: 'kaputt.json', kind: 'invalid', error: 'kaputt' }

// 24 Libraries gespeichert, globaler Zeitpunkt = T0 (echter Refresh).
async function storeWithAllLibraries() {
  const store = await newStore()
  const first = await importLibraryBatch(store, entries(), { now: T0 })

  expect(await noteLibraryImport(store, first.results, { now: T0 })).toBe(true)
  expect(await store.getLastLibraryImportAt()).toBe(T0)

  return store
}

// Reimport einer Auswahl zu einem späteren Zeitpunkt; liefert, ob der globale Zeitpunkt erneuert wurde.
async function reimport(store, batchEntries) {
  const later = T0 + 40 * DAY
  const batch = await importLibraryBatch(store, batchEntries, { now: later })
  const renewed = await noteLibraryImport(store, batch.results, { now: later })

  expect(await store.getLastLibraryImportAt()).toBe(renewed ? later : T0)

  return { renewed, batch }
}

describe('global timestamp only after a complete, clean refresh (24 stored)', () => {
  it.each([
    ['A: 1 of 24 known', 1],
    ['B: 5 of 24 known', 5],
    ['C: 23 of 24 known', 23],
  ])('%s: does not renew', async (_label, count) => {
    const store = await storeWithAllLibraries()
    const { renewed, batch } = await reimport(store, entries(count))

    expect(batch.results.every((result) => result.status === BATCH_STATUS.KNOWN)).toBe(true)
    expect(renewed).toBe(false)
  })

  it('D: all 24 known and clean renews', async () => {
    const store = await storeWithAllLibraries()
    const { renewed, batch } = await reimport(store, entries())

    expect(batch.results).toHaveLength(COUNT)
    expect(renewed).toBe(true)
  })

  it('E: 23 clean plus 1 broken file does not renew', async () => {
    const store = await storeWithAllLibraries()

    expect((await reimport(store, [...entries(23), invalidEntry])).renewed).toBe(false)
  })

  it('F: all 24 clean plus an additional broken file does not renew (the batch contains an error)', async () => {
    const store = await storeWithAllLibraries()

    expect((await reimport(store, [...entries(), invalidEntry])).renewed).toBe(false)
  })

  it('F2: a skipped duplicate file in an otherwise complete batch does not renew', async () => {
    const store = await storeWithAllLibraries()
    const duplicate = { ...entryOf(ORIGINALS[0]), fileName: 'lib-refresh-00-kopie.json' }

    expect((await reimport(store, [...entries(), duplicate])).renewed).toBe(false)
  })

  it('G: a single version update does not renew', async () => {
    const store = await storeWithAllLibraries()
    const patched = rawLibrary(3, { libraryVersion: '1.0.1' })
    const { renewed, batch } = await reimport(store, [entryOf(patched)])

    expect(batch.results[0].status).toBe(BATCH_STATUS.VERSION_UPDATED)
    expect(renewed).toBe(false)
  })

  it('H: a complete 24 batch containing a successful version update renews', async () => {
    const store = await storeWithAllLibraries()
    const patched = rawLibrary(3, { libraryVersion: '1.0.1' })
    const batchEntries = entries().map((entry, index) => (index === 3 ? entryOf(patched) : entry))
    const { renewed, batch } = await reimport(store, batchEntries)

    expect(batch.results.filter((result) => result.status === BATCH_STATUS.VERSION_UPDATED)).toHaveLength(1)
    expect(batch.results.filter((result) => result.status === BATCH_STATUS.KNOWN)).toHaveLength(COUNT - 1)
    expect(renewed).toBe(true)
  })

  it('a complete batch with a pending update renews only after that update was confirmed in the same batch context', async () => {
    const store = await storeWithAllLibraries()
    const revised = rawLibrary(5, { libraryVersion: '1.1.0', activeQuestionIndexHash: hex(200), contentRevisions: { [ORIGINALS[5].questions[1].id]: 2 } })
    const batchEntries = entries().map((entry, index) => (index === 5 ? entryOf(revised) : entry))
    const later = T0 + 40 * DAY
    const batch = await importLibraryBatch(store, batchEntries, { now: later })
    const pendingResult = batch.results.find((result) => result.status === BATCH_STATUS.UPDATE_PENDING)

    expect(pendingResult).toBeDefined()
    expect(await noteLibraryImport(store, batch.results, { now: later })).toBe(false)

    await confirmPendingUpdate(store, batch.pending.get(pendingResult.libraryId), { now: later })

    const confirmed = batch.results.map((result) => (result === pendingResult ? { ...result, status: BATCH_STATUS.VERSION_UPDATED } : result))

    expect(await noteLibraryImport(store, confirmed, { now: later })).toBe(true)
    expect(await store.getLastLibraryImportAt()).toBe(later)
  })

  it('a confirmed update alone (without the batch context of all libraries) does not renew', async () => {
    const store = await storeWithAllLibraries()
    const revised = rawLibrary(5, { libraryVersion: '1.1.0', activeQuestionIndexHash: hex(200), contentRevisions: { [ORIGINALS[5].questions[1].id]: 2 } })
    const batch = await importLibraryBatch(store, [entryOf(revised)], { now: T0 + 40 * DAY })
    const pendingResult = batch.results[0]

    await confirmPendingUpdate(store, batch.pending.get(pendingResult.libraryId), { now: T0 + 40 * DAY })
    expect(await noteLibraryImport(store, [{ ...pendingResult, status: BATCH_STATUS.VERSION_UPDATED }], { now: T0 + 40 * DAY })).toBe(false)
    expect(await store.getLastLibraryImportAt()).toBe(T0)
  })

  it('the very first import defines the catalog: a clean batch sets the timestamp, a batch with an error does not', async () => {
    const clean = await newStore()
    const cleanBatch = await importLibraryBatch(clean, entries(3), { now: T0 })

    expect(await noteLibraryImport(clean, cleanBatch.results, { now: T0 })).toBe(true)
    clean.close()

    dbName = `refresh-db-${Math.random().toString(36).slice(2)}`

    const dirty = await newStore()
    const dirtyBatch = await importLibraryBatch(dirty, [...entries(3), invalidEntry], { now: T0 })

    expect(await noteLibraryImport(dirty, dirtyBatch.results, { now: T0 })).toBe(false)
    expect(await dirty.getLastLibraryImportAt()).toBeNull()
  })

  it('decides from library identities and the stored catalog, not from file names or counts', async () => {
    const store = await storeWithAllLibraries()
    const renamed = entries().map((entry, index) => ({ ...entry, fileName: `datei-${index}.json` }))

    expect((await reimport(store, renamed)).renewed).toBe(true)
  })

  it('the pure rule', () => {
    const ok = (libraryId, status = BATCH_STATUS.KNOWN) => ({ fileName: `${libraryId}.json`, libraryId, status })

    expect(isCompleteCleanRefresh([ok('a'), ok('b')], ['a', 'b'])).toBe(true)
    expect(isCompleteCleanRefresh([ok('a')], ['a', 'b'])).toBe(false)
    expect(isCompleteCleanRefresh([ok('a'), ok('b'), { fileName: 'x.json', status: BATCH_STATUS.INVALID }], ['a', 'b'])).toBe(false)
    expect(isCompleteCleanRefresh([ok('a'), ok('b', BATCH_STATUS.UPDATE_PENDING)], ['a', 'b'])).toBe(false)
    expect(isCompleteCleanRefresh([ok('a'), ok('b', BATCH_STATUS.UPDATE_BLOCKED)], ['a', 'b'])).toBe(false)
    expect(isCompleteCleanRefresh([ok('a'), { fileName: 'retired-index.json', status: 'retiredIndexLoaded' }], ['a'])).toBe(true)
    expect(isCompleteCleanRefresh([{ fileName: 'retired-index.json', status: 'retiredIndexLoaded' }], ['a'])).toBe(false)
    expect(isCompleteCleanRefresh([], ['a'])).toBe(false)
    expect(isCompleteCleanRefresh([ok('a')], [])).toBe(false)
  })
})

// --- Fix 3: Zeitpunkt in der Zukunft -----------------------------------------------------------------------------------

describe('timestamp in the future (clock was set ahead and corrected)', () => {
  it.each([
    ['exactly one millisecond ahead', 1],
    ['one minute ahead', 60 * 1000],
    ['one day ahead', DAY],
    ['one year ahead', 365 * DAY],
  ])('%s: starts a new baseline from now, no crash, no reminder, nothing deleted', async (_label, ahead) => {
    const store = await newStore()

    await importLibraryBatch(store, entries(3), { now: T0 })
    await store.recordLibraryImport(T0 + ahead, REFRESH_ORIGIN.IMPORT)

    const before = JSON.stringify([await store.listLibraryStates(), await store.listAllProgress(), await store.listExamAttempts()])
    const state = await loadLibraryRefresh(store, { now: T0 })

    expect(state).toEqual({ importedAt: T0, origin: 'baseline', ageDays: 0, due: false })
    expect(await store.getLastLibraryImportAt()).toBe(T0)
    expect(JSON.stringify([await store.listLibraryStates(), await store.listAllProgress(), await store.listExamAttempts()])).toBe(before)
    // Ab der neuen Baseline gelten wieder die 30 Tage.
    expect((await loadLibraryRefresh(store, { now: T0 + 29 * DAY })).due).toBe(false)
    expect(await loadLibraryRefresh(store, { now: T0 + 30 * DAY })).toMatchObject({ due: true, origin: 'baseline' })
  })

  it('does not write anything without libraries', async () => {
    const store = await newStore()

    await store.recordLibraryImport(T0 + DAY, REFRESH_ORIGIN.IMPORT)
    expect(await loadLibraryRefresh(store, { now: T0 })).toEqual({ importedAt: null, origin: null, ageDays: null, due: false })
    expect(await store.getLastLibraryImportAt()).toBe(T0 + DAY)
  })
})

// --- Fix 2: Baseline ist kein Aktualisierungsdatum ---------------------------------------------------------------------

describe('baseline versus real refresh (origin)', () => {
  it('stays a baseline through partial imports and becomes a real refresh after a complete clean one', async () => {
    const store = await newStore()

    await importLibraryBatch(store, entries(24), { now: T0 })
    expect((await loadLibraryRefresh(store, { now: T0 + 10 * DAY })).origin).toBe('baseline')

    const partial = await importLibraryBatch(store, entries(5), { now: T0 + 20 * DAY })

    expect(await noteLibraryImport(store, partial.results, { now: T0 + 20 * DAY })).toBe(false)
    expect(await loadLibraryRefresh(store, { now: T0 + 20 * DAY })).toMatchObject({ origin: 'baseline', importedAt: T0 + 10 * DAY })

    const full = await importLibraryBatch(store, entries(24), { now: T0 + 25 * DAY })

    expect(await noteLibraryImport(store, full.results, { now: T0 + 25 * DAY })).toBe(true)
    expect(await loadLibraryRefresh(store, { now: T0 + 26 * DAY })).toMatchObject({ origin: 'import', importedAt: T0 + 25 * DAY, ageDays: 1 })
  })
})
