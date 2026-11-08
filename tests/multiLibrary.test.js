import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createProgressStore, DB_VERSION, STORAGE_SCHEMA_VERSION } from '../src/storage/progressStore.js'
import { importLibraryBatch, confirmPendingUpdate } from '../src/storage/catalogImport.js'
import { buildOverview, buildSectionView, readCatalogData, readSectionData } from '../src/storage/sectionService.js'
import { BATCH_REASON, BATCH_STATUS, groupBySection, planLibraryBatch, sectionLabel, summarizeSectionProgress } from '../src/domain/libraryCatalog.js'
import { parseQuestionFile } from '../src/lib/library/parseLibrary.js'
import { translate } from '../src/i18n/index.js'
import { makeSyntheticLibrary } from './fixtures/syntheticLibrary.js'

let dbName
let openStores

const hash = (char) => `sha256:${char.repeat(64)}`

// Library-Rohdaten (V2) mit eigener Section und eigenem ID-Präfix (IDs sind global eindeutig).
function raw(libraryId, { section = 'la01', prefix, count = 3, ...options } = {}) {
  return makeSyntheticLibrary({
    libraryId,
    learningSectionId: section,
    idPrefix: prefix ?? `sec-a${String(section.replace(/\D/g, '')).padStart(2, '0')}`,
    count,
    activeQuestionIndexHash: hash(libraryId.length.toString(16).slice(-1)),
    ...options,
  })
}

function entry(data, fileName = `${data.libraryId}.json`) {
  return { fileName, kind: 'v2', ...parseQuestionFile(data) }
}

function openStore(name = dbName) {
  const store = createProgressStore({ dbName: name })
  openStores.push(store)
  return store
}

beforeEach(() => {
  dbName = `multi-db-${Math.random().toString(36).slice(2)}`
  openStores = []
})

afterEach(() => openStores.forEach((store) => store.close()))

async function newStore() {
  const store = openStore()
  await store.initialize()
  return store
}

describe('multi-file import', () => {
  it('imports a single library and recognises id, version, hash and learning section', async () => {
    const store = await newStore()
    const data = raw('lib-one', { section: 'la08', libraryVersion: '1.2.3', activeQuestionIndexHash: hash('e') })
    const batch = await importLibraryBatch(store, [entry(data)])

    expect(batch.results).toHaveLength(1)
    expect(batch.results[0]).toMatchObject({ status: BATCH_STATUS.NEW, libraryId: 'lib-one', learningSectionId: 'la08' })

    const state = await store.getLibraryState('lib-one')

    expect(state).toMatchObject({
      libraryId: 'lib-one',
      libraryVersion: '1.2.3',
      activeQuestionIndexHash: hash('e'),
      learningSectionId: 'la08',
      questionCount: 3,
    })
    expect((await store.getLibraryContent('lib-one')).questions.map((question) => question.id)).toEqual(
      data.questions.map((question) => question.id),
    )
  })

  it('imports several libraries of different sections together and groups them numerically', async () => {
    const store = await newStore()
    const batch = await importLibraryBatch(store, [
      entry(raw('lib-ten', { section: 'la10' })),
      entry(raw('lib-two-a', { section: 'la02' })),
      entry(raw('lib-one', { section: 'la01' })),
      entry(raw('lib-two-b', { section: 'la02', prefix: 'sec-a52' })),
    ])

    expect(batch.results.every((result) => result.status === BATCH_STATUS.NEW)).toBe(true)

    const overview = buildOverview(await readCatalogData(store))

    expect(overview.sections.map((section) => translate('de', section.label))).toEqual(['Lernabschnitt 1', 'Lernabschnitt 2', 'Lernabschnitt 10'])
    expect(overview.sections.map((section) => section.libraryCount)).toEqual([1, 2, 1])
    expect(overview.sections.map((section) => section.questionCount)).toEqual([3, 6, 3])
    expect(translate('de', sectionLabel('la08'))).toBe('Lernabschnitt 8')
    expect(translate('en', sectionLabel('la08'))).toBe('Learning section 8')
  })

  it('computes the batch summary from the actual files, not from constants', async () => {
    const store = await newStore()
    const entries = [
      entry(raw('lib-a', { section: 'la01', count: 5 })),
      entry(raw('lib-b', { section: 'la01', count: 2, prefix: 'sec-a51' })),
      entry(raw('lib-c', { section: 'la03', count: 4 })),
      { fileName: 'broken.json', kind: 'invalid', error: 'kaputt' },
    ]
    const batch = await importLibraryBatch(store, entries)

    expect(batch.summary).toEqual({ filesChecked: 4, librariesRecognized: 3, sectionsRecognized: 2, activeQuestions: 11 })
  })

  it('reports an invalid file without blocking the valid ones', async () => {
    const store = await newStore()
    const batch = await importLibraryBatch(store, [
      entry(raw('lib-ok-1', { section: 'la01' })),
      { fileName: 'broken.json', kind: 'invalid', error: 'V2-Library: "libraryId" fehlt oder ist ungültig.' },
      entry(raw('lib-ok-2', { section: 'la02' })),
    ])
    const byFile = Object.fromEntries(batch.results.map((result) => [result.fileName, result]))

    expect(byFile['broken.json']).toMatchObject({ status: BATCH_STATUS.INVALID, message: expect.stringContaining('libraryId') })
    expect(byFile['lib-ok-1.json'].status).toBe(BATCH_STATUS.NEW)
    expect(byFile['lib-ok-2.json'].status).toBe(BATCH_STATUS.NEW)
    expect((await store.listLibraryStates()).map((state) => state.libraryId).sort()).toEqual(['lib-ok-1', 'lib-ok-2'])
  })

  it('skips V1 files inside a multi-file batch with an explanation', async () => {
    const store = await newStore()
    const batch = await importLibraryBatch(store, [
      entry(raw('lib-ok', { section: 'la01' })),
      { fileName: 'old.json', kind: 'v1', questions: [] },
    ])

    expect(batch.results.find((result) => result.fileName === 'old.json')).toMatchObject({
      status: BATCH_STATUS.SKIPPED,
      reason: BATCH_REASON.NOT_A_LIBRARY,
    })
  })
})

describe('batch conflicts', () => {
  it('treats the identical library twice as one and reports the duplicate', async () => {
    const store = await newStore()
    const data = raw('lib-dup')
    const batch = await importLibraryBatch(store, [entry(data, 'b-copy.json'), entry(data, 'a-original.json')])

    expect(batch.results.find((result) => result.fileName === 'a-original.json').status).toBe(BATCH_STATUS.NEW)
    expect(batch.results.find((result) => result.fileName === 'b-copy.json')).toMatchObject({
      status: BATCH_STATUS.SKIPPED,
      reason: BATCH_REASON.IDENTICAL_DUPLICATE,
    })
    expect(await store.listLibraryStates()).toHaveLength(1)
  })

  it('uses the higher version deterministically when versions differ', async () => {
    for (const order of [['old', 'new'], ['new', 'old']]) {
      const store = openStore(`${dbName}-${order.join('')}`)
      await store.initialize()
      const files = {
        old: entry(raw('lib-ver', { libraryVersion: '1.0.0' }), 'ver-1.0.0.json'),
        new: entry(raw('lib-ver', { libraryVersion: '1.0.1' }), 'ver-1.0.1.json'),
      }
      const batch = await importLibraryBatch(store, order.map((key) => files[key]))

      expect(batch.results.find((result) => result.fileName === 'ver-1.0.1.json').status).toBe(BATCH_STATUS.NEW)
      expect(batch.results.find((result) => result.fileName === 'ver-1.0.0.json')).toMatchObject({
        status: BATCH_STATUS.SKIPPED,
        reason: BATCH_REASON.SUPERSEDED,
      })
      expect((await store.getLibraryState('lib-ver')).libraryVersion).toBe('1.0.1')
    }
  })

  it('reports a batch conflict (same version, different question landscape) and imports neither', async () => {
    const store = await newStore()
    const batch = await importLibraryBatch(store, [
      entry(raw('lib-conflict', { libraryVersion: '1.0.0', activeQuestionIndexHash: hash('1') }), 'x.json'),
      entry(raw('lib-conflict', { libraryVersion: '1.0.0', activeQuestionIndexHash: hash('2') }), 'y.json'),
      entry(raw('lib-fine', { section: 'la02' })),
    ])

    expect(batch.results.filter((result) => result.reason === BATCH_REASON.BATCH_CONFLICT)).toHaveLength(2)
    expect(await store.getLibraryState('lib-conflict')).toBeNull()
    expect(await store.getLibraryState('lib-fine')).not.toBeNull()
  })

  it('blocks both libraries when two active libraries claim the same question id', async () => {
    const store = await newStore()
    const batch = await importLibraryBatch(store, [
      entry(raw('lib-x', { section: 'la01', prefix: 'sec-a60' })),
      entry(raw('lib-y', { section: 'la02', prefix: 'sec-a60' })),
      entry(raw('lib-z', { section: 'la03' })),
    ])

    const blocked = batch.results.filter((result) => result.reason === BATCH_REASON.DUPLICATE_QUESTION_IDS)

    expect(blocked.map((result) => result.libraryId).sort()).toEqual(['lib-x', 'lib-y'])
    expect(blocked[0].conflictingLibraryIds.length).toBe(1)
    expect((await store.listLibraryStates()).map((state) => state.libraryId)).toEqual(['lib-z'])
  })

  it('blocks a new library whose question ids are already active in a stored library (no overwrite)', async () => {
    const store = await newStore()
    await importLibraryBatch(store, [entry(raw('lib-stored', { prefix: 'sec-a61' }))])
    await store.recordAnswer({ libraryId: 'lib-stored', questionId: 'sec-a61-0001', isCorrect: true })

    const batch = await importLibraryBatch(store, [entry(raw('lib-intruder', { prefix: 'sec-a61', section: 'la05' }))])

    expect(batch.results[0]).toMatchObject({ status: BATCH_STATUS.REJECTED, reason: BATCH_REASON.DUPLICATE_QUESTION_IDS })
    expect(await store.getLibraryState('lib-intruder')).toBeNull()
    expect(await store.getQuestionProgress('lib-stored', 'sec-a61-0001')).toMatchObject({ attempts: 1 })
  })

  it('rejects mixed learning sections inside one library at parse time', () => {
    const data = raw('lib-mixed')

    data.questions[1].learningSectionId = 'la02'
    expect(() => parseQuestionFile(data)).toThrow(/Lernabschnitten/)
    data.questions.forEach((question) => delete question.learningSectionId)
    expect(() => parseQuestionFile(data)).toThrow(/Lernabschnitt nicht erkennbar/)
  })

  it('rejects a library that moves to another learning section', async () => {
    const store = await newStore()
    await importLibraryBatch(store, [entry(raw('lib-move', { section: 'la01' }))])

    const batch = await importLibraryBatch(store, [entry(raw('lib-move', { section: 'la02', libraryVersion: '1.0.1' }))])

    expect(batch.results[0]).toMatchObject({ status: BATCH_STATUS.REJECTED, reason: 'section-changed' })
    expect((await store.getLibraryState('lib-move')).learningSectionId).toBe('la01')
  })

  it('only one retired index per batch', async () => {
    const store = await newStore()
    const index = { 'sec-a30-0004': { replacedBy: 'sec-a31-0001', progressMigration: 'reset', reason: 'x' } }
    const retired = (fileName) => ({ fileName, kind: 'retiredIndex', retiredIndex: parseQuestionFile(index).retiredIndex })
    const batch = await importLibraryBatch(store, [retired('r1.json'), retired('r2.json')])

    expect(batch.results.every((result) => result.reason === BATCH_REASON.MULTIPLE_RETIRED_INDEXES)).toBe(true)
    expect(await store.getRetiredIndex()).toBeNull()
  })

  it('planLibraryBatch is pure and returns the same decision regardless of file order', () => {
    const entries = [
      entry(raw('lib-p', { libraryVersion: '1.0.0' }), 'p0.json'),
      entry(raw('lib-p', { libraryVersion: '1.1.0' }), 'p1.json'),
      entry(raw('lib-q', { section: 'la02' }), 'q.json'),
    ]
    const forward = planLibraryBatch(entries)
    const backward = planLibraryBatch([...entries].reverse())

    expect(forward.importable.map((item) => item.fileName)).toEqual(backward.importable.map((item) => item.fileName))
    expect(forward.importable.map((item) => item.fileName)).toEqual(['p1.json', 'q.json'])
  })
})

describe('catalog persistence and partial imports', () => {
  it('shows the catalog after a reload without re-importing any file', async () => {
    const first = await newStore()
    await importLibraryBatch(first, [entry(raw('lib-r1', { section: 'la04' })), entry(raw('lib-r2', { section: 'la04', prefix: 'sec-a54' }))])
    await first.recordAnswer({ libraryId: 'lib-r1', questionId: 'sec-a04-0001', isCorrect: true })
    first.close()

    const second = await newStore()
    const overview = buildOverview(await readCatalogData(second))

    expect(overview.sections).toMatchObject([
      { label: { i18n: 'section.label', params: { id: '4' } }, libraryCount: 2, questionCount: 6, answeredCount: 1, openCount: 5, percent: 17 },
    ])
    expect((await second.getLibraryContent('lib-r2')).questions).toHaveLength(3)
  })

  it('works with a partial import and extends the section on a later import (progress stays)', async () => {
    const store = await newStore()
    await importLibraryBatch(store, [entry(raw('lib-part-1', { section: 'la06' }))])
    await store.recordAnswer({ libraryId: 'lib-part-1', questionId: 'sec-a06-0001', isCorrect: false })

    expect(buildOverview(await readCatalogData(store)).sections).toHaveLength(1)

    await importLibraryBatch(store, [entry(raw('lib-part-2', { section: 'la06', prefix: 'sec-a56', count: 2 })), entry(raw('lib-other', { section: 'la07' }))])

    const overview = buildOverview(await readCatalogData(store))

    expect(overview.sections).toMatchObject([
      { label: { i18n: 'section.label', params: { id: '6' } }, libraryCount: 2, questionCount: 5, answeredCount: 1 },
      { label: { i18n: 'section.label', params: { id: '7' } }, libraryCount: 1, questionCount: 3, answeredCount: 0 },
    ])
    expect(await store.getQuestionProgress('lib-part-1', 'sec-a06-0001')).toMatchObject({ attempts: 1, incorrectCount: 1 })
  })

  it('aggregates section progress over all libraries and ignores retired/historical records', async () => {
    const store = await newStore()
    await importLibraryBatch(store, [
      entry(raw('lib-agg-a', { section: 'la09', count: 3 })),
      entry(raw('lib-agg-b', { section: 'la09', count: 2, prefix: 'sec-a59' })),
    ])
    await store.recordAnswer({ libraryId: 'lib-agg-a', questionId: 'sec-a09-0001', isCorrect: true })
    await store.recordAnswer({ libraryId: 'lib-agg-b', questionId: 'sec-a59-0002', isCorrect: false })
    // Retired Frage (nicht mehr aktiv) und historischer Datensatz zählen nicht als aktive Fragen.
    await store.upsertQuestionProgress({
      libraryId: 'lib-agg-a', questionId: 'sec-a09-0099', attempts: 3, correctCount: 3, incorrectCount: 0,
      lastResult: 'correct', answered: true, lastAnsweredAt: 1,
    })
    await store.upsertQuestionProgress({
      libraryId: 'lib-agg-a', questionId: 'sec-a09-0003', attempts: 1, correctCount: 1, incorrectCount: 0,
      lastResult: 'correct', answered: true, lastAnsweredAt: 1, historical: true, migratedTo: { libraryId: 'lib-agg-b', questionId: 'sec-a59-0001' },
    })

    const data = await readCatalogData(store)
    const summary = summarizeSectionProgress(groupBySection(data.states)[0].libraries, data.progress)

    expect(summary).toMatchObject({ totalQuestions: 5, answeredCount: 2, openCount: 3, percent: 40 })
  })

  it('maps a state from an older app version (no section/content) once the file is imported again', async () => {
    const store = await newStore()
    const data = raw('lib-legacy', { section: 'la02' })
    const { library } = entry(data)

    await store.upsertLibraryState({
      libraryId: library.libraryId, libraryVersion: library.libraryVersion, activeQuestionIndexHash: library.activeQuestionIndexHash,
      questionRevisions: library.questionRevisions, firstImportedAt: 1, lastAccessedAt: 1,
    })
    await store.recordAnswer({ libraryId: 'lib-legacy', questionId: 'sec-a02-0001', isCorrect: true })

    expect(buildOverview(await readCatalogData(store))).toMatchObject({ sections: [], uncatalogedLibraryIds: ['lib-legacy'] })

    const batch = await importLibraryBatch(store, [entry(data)])

    expect(batch.results[0].status).toBe(BATCH_STATUS.KNOWN)
    expect(buildOverview(await readCatalogData(store))).toMatchObject({
      sections: [{ label: { i18n: 'section.label', params: { id: '2' } }, answeredCount: 1 }],
      uncatalogedLibraryIds: [],
    })
    expect(await store.getLibraryContent('lib-legacy')).not.toBeNull()
  })
})

describe('library updates through the batch import', () => {
  it('same hash, same version: already current, nothing rewritten', async () => {
    const store = await newStore()
    const data = raw('lib-same')
    await importLibraryBatch(store, [entry(data)], { now: 1000 })
    const batch = await importLibraryBatch(store, [entry(data)], { now: 2000 })

    expect(batch.results[0].status).toBe(BATCH_STATUS.KNOWN)
    expect(await store.getLibraryState('lib-same')).toMatchObject({ firstImportedAt: 1000, lastAccessedAt: 2000 })
  })

  it('same hash, higher version: updated metadata, progress and stored questions stay valid', async () => {
    const store = await newStore()
    await importLibraryBatch(store, [entry(raw('lib-v'))])
    await store.recordAnswer({ libraryId: 'lib-v', questionId: 'sec-a01-0001', isCorrect: true })

    const batch = await importLibraryBatch(store, [entry(raw('lib-v', { libraryVersion: '1.0.1' }))])

    expect(batch.results[0].status).toBe(BATCH_STATUS.VERSION_UPDATED)
    expect((await store.getLibraryState('lib-v')).libraryVersion).toBe('1.0.1')
    expect((await store.getLibraryContent('lib-v')).libraryVersion).toBe('1.0.1')
    expect(await store.getQuestionProgress('lib-v', 'sec-a01-0001')).toMatchObject({ attempts: 1 })
  })

  it('other hash: pending confirmation, nothing changes until confirmed; then catalog, count and content update', async () => {
    const store = await newStore()
    await importLibraryBatch(store, [entry(raw('lib-u', { count: 3 }))])
    await store.recordAnswer({ libraryId: 'lib-u', questionId: 'sec-a01-0001', isCorrect: true })

    const updated = entry(raw('lib-u', { count: 4, libraryVersion: '1.1.0', activeQuestionIndexHash: hash('9') }))
    const batch = await importLibraryBatch(store, [updated])

    expect(batch.results[0].status).toBe(BATCH_STATUS.UPDATE_PENDING)
    expect(batch.pending.has('lib-u')).toBe(true)
    expect(await store.getLibraryState('lib-u')).toMatchObject({ libraryVersion: '1.0.0', questionCount: 3 })
    expect((await store.getLibraryContent('lib-u')).questions).toHaveLength(3)

    await confirmPendingUpdate(store, batch.pending.get('lib-u'))

    expect(await store.getLibraryState('lib-u')).toMatchObject({ libraryVersion: '1.1.0', questionCount: 4 })
    expect((await store.getLibraryContent('lib-u')).questions).toHaveLength(4)
    expect(buildOverview(await readCatalogData(store)).sections[0]).toMatchObject({ questionCount: 4, answeredCount: 1 })
  })

  it('replacement update uses the Phase 2D logic (inherit) and reports a replacement migration', async () => {
    const store = await newStore()
    await importLibraryBatch(store, [
      entry(raw('lib-old', { section: 'la01', prefix: 'sec-a30', count: 4 })),
      entry(raw('lib-new', { section: 'la01', prefix: 'sec-a31', count: 2 })),
    ])
    await store.recordAnswer({ libraryId: 'lib-old', questionId: 'sec-a30-0004', isCorrect: false })
    await store.recordAnswer({ libraryId: 'lib-old', questionId: 'sec-a30-0004', isCorrect: true })

    const retiredIndex = parseQuestionFile({
      'sec-a30-0004': { replacedBy: 'sec-a31-0001', progressMigration: 'inherit', learningGoalEquivalence: 'confirmed', reason: 'x' },
    }).retiredIndex
    const reduced = entry(raw('lib-old', { section: 'la01', prefix: 'sec-a30', count: 4, omitIds: ['sec-a30-0004'], libraryVersion: '2.0.0', activeQuestionIndexHash: hash('8') }))

    // Ohne Ersetzungsliste ist das Update nicht übernehmbar …
    const blocked = await importLibraryBatch(store, [reduced])

    expect(blocked.results[0].status).toBe(BATCH_STATUS.UPDATE_BLOCKED)

    // … mit Ersetzungsliste im selben Batch wird es als Replacement-Migration zur Bestätigung angeboten.
    const batch = await importLibraryBatch(store, [{ fileName: 'retired-index.json', kind: 'retiredIndex', retiredIndex }, reduced])

    expect(batch.results.find((result) => result.libraryId === 'lib-old').status).toBe(BATCH_STATUS.REPLACEMENT_PENDING)
    expect(await store.getQuestionProgress('lib-new', 'sec-a31-0001')).toBeNull()

    await confirmPendingUpdate(store, batch.pending.get('lib-old'), { retiredIndex: batch.retiredIndex })

    expect(await store.getQuestionProgress('lib-new', 'sec-a31-0001')).toMatchObject({ attempts: 2, correctCount: 1, incorrectCount: 1 })
    expect(await store.getQuestionProgress('lib-old', 'sec-a30-0004')).toMatchObject({ historical: true })
    // Retired Fortschritt zählt nicht in der Abschnittsübersicht; der übernommene schon.
    expect(buildOverview(await readCatalogData(store)).sections[0]).toMatchObject({ questionCount: 5, answeredCount: 1 })
  })
})

describe('storage version', () => {
  it('keeps storageSchemaVersion 1 and raises only the DB version (new additive store)', async () => {
    const store = await newStore()

    expect(DB_VERSION).toBe(4)
    expect(STORAGE_SCHEMA_VERSION).toBe(1)
    expect(await store.getStorageSchemaVersion()).toBe(1)
  })

  it('upgrades an existing Phase 2D database (DB version 2) without losing data', async () => {
    await new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, 2)

      request.onupgradeneeded = () => {
        const database = request.result

        database.createObjectStore('meta', { keyPath: 'key' }).put({ key: 'storageSchemaVersion', value: 1 })
        database.createObjectStore('libraries', { keyPath: 'libraryId' }).put({
          libraryId: 'old-lib', libraryVersion: '1.0.0', activeQuestionIndexHash: hash('4'),
          questionRevisions: { 'sec-a01-0001': 1 }, firstImportedAt: 1, lastAccessedAt: 1,
        })
        database.createObjectStore('progress', { keyPath: ['libraryId', 'questionId'] })
          .put({ libraryId: 'old-lib', questionId: 'sec-a01-0001', attempts: 2, correctCount: 1, incorrectCount: 1, lastResult: 'correct', answered: true, lastAnsweredAt: 5 })
        database.createObjectStore('sessions', { keyPath: 'sessionId' }).createIndex('byLibrary', 'libraryId')
      }
      request.onsuccess = () => {
        request.result.close()
        resolve()
      }
      request.onerror = () => reject(request.error)
    })

    const store = await newStore()

    expect(await store.getLibraryState('old-lib')).toMatchObject({ libraryVersion: '1.0.0' })
    expect(await store.getQuestionProgress('old-lib', 'sec-a01-0001')).toMatchObject({ attempts: 2 })
    expect(await store.getLibraryContent('old-lib')).toBeNull()
    // Der alte State gehört noch nicht zum Katalog, bis seine Datei erneut importiert wurde.
    expect(buildOverview(await readCatalogData(store)).uncatalogedLibraryIds).toEqual(['old-lib'])
  })
})

describe('section view', () => {
  it('collects the questions of all libraries of a section with stable ids and library ownership', async () => {
    const store = await newStore()
    const a = raw('lib-sv-a', { section: 'la05', count: 3 })
    const b = raw('lib-sv-b', { section: 'la05', count: 2, prefix: 'sec-a55' })

    await importLibraryBatch(store, [entry(a), entry(b), entry(raw('lib-sv-c', { section: 'la06' }))])

    const view = buildSectionView(await readSectionData(store, 'la05'))

    expect(translate('de', view.label)).toBe('Lernabschnitt 5')
    expect(view.questions.map((question) => question.id).sort()).toEqual(
      [...a.questions, ...b.questions].map((question) => question.id).sort(),
    )
    expect(new Set(view.questions.filter((question) => question.id.startsWith('sec-a55')).map((question) => question.libraryId))).toEqual(new Set(['lib-sv-b']))
  })
})
