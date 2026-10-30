import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProgressStore } from '../src/storage/progressStore.js'
import { IMPORT_STATUS, applyLibraryUpdate, registerLibraryImport } from '../src/storage/libraryImport.js'
import {
  MigrationError,
  RetiredIndexError,
  applyReplacementToProgress,
  mergePortableProgress,
  parseRetiredIndex,
  planReplacements,
} from '../src/domain/replacementMigration.js'
import { CHANGE_KIND } from '../src/domain/libraryUpdate.js'
import { SESSION_STATUS, createSessionRecord, evaluateSession, migrateSessionReplacements } from '../src/domain/session.js'
import { parseV2Library } from '../src/lib/library/parseLibrary.js'
import { makeSyntheticLibrary } from './fixtures/syntheticLibrary.js'

const A = 'repl-lib-a'
const B = 'repl-lib-b'
const HASH_2 = `sha256:${'2'.repeat(64)}`
const HASH_B2 = `sha256:${'3'.repeat(64)}`
const A_IDS = ['sec-a30-0001', 'sec-a30-0002', 'sec-a30-0003', 'sec-a30-0004']

const inherit = (replacedBy) => ({ replacedBy, progressMigration: 'inherit', learningGoalEquivalence: 'confirmed', reason: 'synthetic' })
const reset = (replacedBy) => ({ replacedBy, progressMigration: 'reset', reason: 'synthetic' })

let store
let dbName

function libA(options = {}) {
  return parseV2Library(makeSyntheticLibrary({ libraryId: A, idPrefix: 'sec-a30', ...options }))
}

function libB(options = {}) {
  return parseV2Library(makeSyntheticLibrary({ libraryId: B, idPrefix: 'sec-a31', count: 3, ...options }))
}

// A v1 (0001–0004) und B (a31-0001…0003) sind bekannt; 0004 von A wird in v2 entfernt.
function aV2(options = {}) {
  return libA({ libraryVersion: '2.0.0', activeQuestionIndexHash: HASH_2, omitIds: ['sec-a30-0004'], ...options })
}

async function rawCount(storeName) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName)
    request.onsuccess = () => {
      const database = request.result
      const count = database.transaction(storeName).objectStore(storeName).count()
      count.onsuccess = () => { database.close(); resolve(count.result) }
    }
    request.onerror = () => reject(request.error)
  })
}

async function snapshot() {
  return {
    states: await store.listLibraryStates(),
    progressA: await store.listProgressForLibrary(A),
    progressB: await store.listProgressForLibrary(B),
    sessionA: await store.getLatestSession(A),
    sessionB: await store.getLatestSession(B),
  }
}

async function otherStatesOf(libraryId) {
  return (await store.listLibraryStates()).filter((state) => state.libraryId !== libraryId)
}

async function setup() {
  await registerLibraryImport(store, libA().library, { now: 1000 })
  await registerLibraryImport(store, libB().library, { now: 1000 })
}

beforeEach(async () => {
  dbName = `repl-db-${Math.random().toString(36).slice(2)}`
  store = createProgressStore({ dbName })
  await store.initialize()
})

afterEach(() => store.close())

describe('retired index validation', () => {
  it('accepts valid inherit and reset entries and drops the free-text reason', () => {
    const entries = parseRetiredIndex({ 'sec-a30-0004': inherit('sec-a31-0001'), 'sec-a30-0003': reset('sec-a31-0002') })

    expect(entries).toEqual({
      'sec-a30-0004': { replacedBy: 'sec-a31-0001', progressMigration: 'inherit', learningGoalEquivalence: 'confirmed' },
      'sec-a30-0003': { replacedBy: 'sec-a31-0002', progressMigration: 'reset' },
    })
  })

  const invalid = {
    'inherit without confirmed equivalence': { 'sec-a30-0004': { replacedBy: 'sec-a31-0001', progressMigration: 'inherit' } },
    'inherit with another equivalence value': { 'sec-a30-0004': { ...inherit('sec-a31-0001'), learningGoalEquivalence: 'likely' } },
    'missing policy': { 'sec-a30-0004': { replacedBy: 'sec-a31-0001' } },
    'unknown policy': { 'sec-a30-0004': { replacedBy: 'sec-a31-0001', progressMigration: 'merge' } },
    'legacy string entry': { 'sec-a30-0004': 'sec-a31-0001' },
    'missing replacedBy': { 'sec-a30-0004': { progressMigration: 'reset' } },
    'self cycle': { 'sec-a30-0004': reset('sec-a30-0004') },
    'two-step cycle': { 'sec-a30-0004': reset('sec-a30-0003'), 'sec-a30-0003': reset('sec-a30-0004') },
    'chain (target itself retired)': { 'sec-a30-0004': reset('sec-a30-0003'), 'sec-a30-0003': reset('sec-a31-0001') },
    'option mapping field': { 'sec-a30-0004': { ...inherit('sec-a31-0001'), selectedOptionKey: 'a' } },
    'invalid id': { 'not-an-id': reset('sec-a31-0001') },
  }

  Object.entries(invalid).forEach(([name, data]) => {
    it(`rejects: ${name}`, () => {
      expect(() => parseRetiredIndex(data)).toThrow(RetiredIndexError)
    })
  })

  it('rejects the whole file if any entry is invalid (no silent partial semantics)', () => {
    expect(() =>
      parseRetiredIndex({ 'sec-a30-0004': inherit('sec-a31-0001'), 'sec-a30-0003': { replacedBy: 'sec-a31-0002' } }),
    ).toThrow(RetiredIndexError)
    expect(() => parseRetiredIndex([])).toThrow(RetiredIndexError)
  })
})

describe('replacement plan', () => {
  const index = parseRetiredIndex({ 'sec-a30-0004': inherit('sec-a31-0001') })

  it('resolves the target library across libraries', async () => {
    await setup()
    const plan = planReplacements({
      removedIds: ['sec-a30-0004'], retiredIndex: index, library: aV2().library, otherStates: await otherStatesOf(A),
    })

    expect(plan.replacements).toEqual([{ from: 'sec-a30-0004', to: 'sec-a31-0001', policy: 'inherit', targetLibraryId: B }])
  })

  it('does not explain removals without tombstone or with an unknown target', async () => {
    await setup()
    const states = await otherStatesOf(A)
    const unknownTarget = parseRetiredIndex({ 'sec-a30-0004': inherit('sec-a35-0001') })

    expect(planReplacements({ removedIds: ['sec-a30-0004'], retiredIndex: null, library: aV2().library, otherStates: states }).unexplained)
      .toEqual([{ id: 'sec-a30-0004', reason: 'noTombstone' }])
    expect(planReplacements({ removedIds: ['sec-a30-0004'], retiredIndex: unknownTarget, library: aV2().library, otherStates: states }).unexplained)
      .toEqual([{ id: 'sec-a30-0004', reason: 'targetUnknown' }])
  })

  it('flags a retired ID that is still active in another known library (active + retired)', async () => {
    await setup()
    const conflicting = parseRetiredIndex({ 'sec-a30-0004': inherit('sec-a31-0001') })
    const others = (await otherStatesOf(A)).map((state) =>
      state.libraryId === B ? { ...state, questionRevisions: { ...state.questionRevisions, 'sec-a30-0004': 1 } } : state,
    )

    expect(planReplacements({ removedIds: ['sec-a30-0004'], retiredIndex: conflicting, library: aV2().library, otherStates: others }).problems)
      .toEqual([{ id: 'sec-a30-0004', reason: 'activeAndRetired' }])
  })
})

describe('progress merge (inherit / reset)', () => {
  const sourceKey = { libraryId: A, questionId: 'sec-a30-0004' }
  const targetKey = { libraryId: B, questionId: 'sec-a31-0001' }
  const record = (key, extra) => ({
    ...key, attempts: 2, correctCount: 1, incorrectCount: 1, lastResult: 'incorrect', answered: true, lastAnsweredAt: 100, answeredAtRevision: 1, ...extra,
  })

  it('inherit transfers portable progress, marks the source historical and adds provenance', () => {
    const source = record(sourceKey)
    const result = applyReplacementToProgress({ source, target: undefined, policy: 'inherit', sourceKey, targetKey, now: 5 })

    expect(result.outcome).toBe('inherited')
    expect(result.target).toEqual({
      ...targetKey, attempts: 2, correctCount: 1, incorrectCount: 1, lastResult: 'incorrect', answered: true,
      lastAnsweredAt: 100, inheritedFrom: [sourceKey],
    })
    // answeredAtRevision gehört zur Retire-Frage und wird nicht übertragen
    expect('answeredAtRevision' in result.target).toBe(false)
    expect(result.source).toMatchObject({ ...source, historical: true, migratedTo: { ...targetKey, policy: 'inherit', appliedAt: 5 } })
  })

  it('inherit never transfers option keys, option ids or UI state (class B)', () => {
    const source = record(sourceKey, { selectedOptionKey: 'c', selectedOptionId: 'x', optionOrder: ['d', 'c', 'b', 'a'] })
    const { target } = applyReplacementToProgress({ source, target: undefined, policy: 'inherit', sourceKey, targetKey, now: 5 })

    expect(Object.keys(target).sort()).toEqual(
      ['answered', 'attempts', 'correctCount', 'incorrectCount', 'inheritedFrom', 'lastAnsweredAt', 'lastResult', 'libraryId', 'questionId'],
    )
  })

  it('reset transfers nothing: no target record, source only consumed', () => {
    const result = applyReplacementToProgress({ source: record(sourceKey), target: undefined, policy: 'reset', sourceKey, targetKey, now: 5 })

    expect(result.outcome).toBe('reset')
    expect(result.target).toBeUndefined()
    expect(result.source).toMatchObject({ historical: true, migratedTo: { policy: 'reset' } })
  })

  it('reset leaves an existing target untouched', () => {
    const target = record(targetKey, { attempts: 3, correctCount: 3, incorrectCount: 0, lastResult: 'correct' })
    const result = applyReplacementToProgress({ source: record(sourceKey), target, policy: 'reset', sourceKey, targetKey, now: 5 })

    expect(result.target).toBeUndefined()
  })

  it('merges dual progress field by field without double counting', () => {
    const source = record(sourceKey, { attempts: 3, correctCount: 1, incorrectCount: 2, lastResult: 'correct', lastAnsweredAt: 300 })
    const target = record(targetKey, { attempts: 2, correctCount: 2, incorrectCount: 0, lastResult: 'incorrect', lastAnsweredAt: 200, answeredAtRevision: 4 })
    const merged = mergePortableProgress(target, source, sourceKey, targetKey)

    expect(merged).toMatchObject({
      attempts: 5, correctCount: 3, incorrectCount: 2, answered: true, lastResult: 'correct', lastAnsweredAt: 300,
    })
    expect(merged.attempts).toBe(merged.correctCount + merged.incorrectCount)
    // jüngster Versuch stammt aus der Retire-ID → deren Revisionsnummer wird nicht übernommen
    expect('answeredAtRevision' in merged).toBe(false)
  })

  it('keeps the own result and revision of the keep question if its attempt is the latest', () => {
    const source = record(sourceKey, { lastAnsweredAt: 100, lastResult: 'incorrect' })
    const target = record(targetKey, { lastAnsweredAt: 500, lastResult: 'correct', answeredAtRevision: 4 })
    const merged = mergePortableProgress(target, source, sourceKey, targetKey)

    expect(merged).toMatchObject({ lastResult: 'correct', lastAnsweredAt: 500, answeredAtRevision: 4 })
  })

  it('counts answered credit once and never worsens portable values', () => {
    const source = record(sourceKey, { answered: true })
    const target = record(targetKey, { answered: true })
    const merged = mergePortableProgress(target, source, sourceKey, targetKey)

    expect(merged.answered).toBe(true)
    expect(merged.attempts).toBeGreaterThanOrEqual(target.attempts)
    expect(merged.correctCount).toBeGreaterThanOrEqual(target.correctCount)
  })

  it('is idempotent: a consumed source is not merged a second time', () => {
    const first = applyReplacementToProgress({ source: record(sourceKey), target: record(targetKey), policy: 'inherit', sourceKey, targetKey, now: 5 })
    const second = applyReplacementToProgress({ source: first.source, target: first.target, policy: 'inherit', sourceKey, targetKey, now: 6 })

    expect(second).toEqual({ outcome: 'alreadyMigrated' })
  })

  it('rejects corrupt progress and unknown policies without producing data', () => {
    const corrupt = record(sourceKey, { attempts: 9 })

    expect(() => applyReplacementToProgress({ source: corrupt, target: undefined, policy: 'inherit', sourceKey, targetKey, now: 1 })).toThrow(MigrationError)
    expect(() => applyReplacementToProgress({ source: record(sourceKey), target: record(targetKey, { attempts: -1 }), policy: 'inherit', sourceKey, targetKey, now: 1 })).toThrow(MigrationError)
    expect(() => applyReplacementToProgress({ source: record(sourceKey), target: undefined, policy: 'merge', sourceKey, targetKey, now: 1 })).toThrow(MigrationError)
    expect(applyReplacementToProgress({ source: undefined, target: undefined, policy: 'inherit', sourceKey, targetKey, now: 1 })).toEqual({ outcome: 'noSource' })
  })
})

describe('library update with replacements (store)', () => {
  const index = parseRetiredIndex({ 'sec-a30-0004': inherit('sec-a31-0001') })

  async function seedProgress() {
    await setup()
    await store.recordAnswer({ libraryId: A, questionId: 'sec-a30-0004', isCorrect: false, answeredAt: 100, answeredAtRevision: 1 })
    await store.recordAnswer({ libraryId: A, questionId: 'sec-a30-0004', isCorrect: true, answeredAt: 200, answeredAtRevision: 1 })
  }

  it('hash update with complete retired mapping is offered (explained)', async () => {
    await seedProgress()
    const result = await registerLibraryImport(store, aV2().library, { retiredIndex: index })

    expect(result.status).toBe(IMPORT_STATUS.UPDATE_REQUIRES_MIGRATION)
    expect(result).toMatchObject({ changeKind: CHANGE_KIND.QUESTIONS_REPLACED, compatible: true })
    expect(result.replacements).toHaveLength(1)
  })

  it('hash update with incomplete retired mapping stays blocked and changes nothing', async () => {
    await seedProgress()
    const before = await snapshot()

    for (const retiredIndex of [null, parseRetiredIndex({ 'sec-a30-0003': reset('sec-a31-0002') }), parseRetiredIndex({ 'sec-a30-0004': inherit('sec-a35-0001') })]) {
      const result = await registerLibraryImport(store, aV2().library, { retiredIndex })

      expect(result).toMatchObject({ changeKind: CHANGE_KIND.QUESTIONS_REMOVED, compatible: false })
      await expect(applyLibraryUpdate(store, aV2().library, { retiredIndex })).rejects.toThrow()
    }

    expect(await snapshot()).toEqual(before)
  })

  it('inherit moves portable progress to the keep question; the retire record stays historical and inactive', async () => {
    await seedProgress()
    const result = await applyLibraryUpdate(store, aV2().library, { retiredIndex: index, now: 9000 })

    expect(result.replacements).toEqual([{ from: 'sec-a30-0004', to: 'sec-a31-0001', outcome: 'inherited' }])
    expect(await store.getQuestionProgress(B, 'sec-a31-0001')).toEqual({
      libraryId: B, questionId: 'sec-a31-0001', attempts: 2, correctCount: 1, incorrectCount: 1, lastResult: 'correct',
      answered: true, lastAnsweredAt: 200, inheritedFrom: [{ libraryId: A, questionId: 'sec-a30-0004' }],
    })
    // historischer Datensatz bleibt erhalten, zählt aber nicht als aktiver Fortschritt
    expect(await store.getQuestionProgress(A, 'sec-a30-0004')).toMatchObject({
      attempts: 2, historical: true, migratedTo: { libraryId: B, questionId: 'sec-a31-0001', policy: 'inherit', appliedAt: 9000 },
    })
    expect((await store.getLibraryState(A)).libraryVersion).toBe('2.0.0')
    expect(await rawCount('progress')).toBe(2)
  })

  it('reset gives the keep question no inherited progress', async () => {
    await seedProgress()
    await applyLibraryUpdate(store, aV2().library, { retiredIndex: parseRetiredIndex({ 'sec-a30-0004': reset('sec-a31-0001') }) })

    expect(await store.getQuestionProgress(B, 'sec-a31-0001')).toBeNull()
    expect(await store.getQuestionProgress(A, 'sec-a30-0004')).toMatchObject({ historical: true, migratedTo: { policy: 'reset' } })
  })

  it('dual progress: exactly one active target record, keep answer untouched, second run is a no-op', async () => {
    await seedProgress()
    await store.recordAnswer({ libraryId: B, questionId: 'sec-a31-0001', isCorrect: true, answeredAt: 150, answeredAtRevision: 3 })
    const keepBefore = await store.getQuestionProgress(B, 'sec-a31-0001')

    await applyLibraryUpdate(store, aV2().library, { retiredIndex: index })
    const merged = await store.getQuestionProgress(B, 'sec-a31-0001')

    expect(merged).toMatchObject({ attempts: 3, correctCount: 2, incorrectCount: 1, lastResult: 'correct', lastAnsweredAt: 200, answered: true })
    expect(merged.correctCount + merged.incorrectCount).toBe(merged.attempts)
    expect(keepBefore).toMatchObject({ attempts: 1, answeredAtRevision: 3 })
    expect((await store.listProgressForLibrary(B)).filter((record) => !record.historical)).toHaveLength(1)

    const again = await store.applyReplacementMigration({
      libraryId: A, replacements: [{ from: 'sec-a30-0004', to: 'sec-a31-0001', policy: 'inherit', targetLibraryId: B }],
    })

    expect(again).toEqual([{ from: 'sec-a30-0004', to: 'sec-a31-0001', outcome: 'alreadyMigrated' }])
    expect(await store.getQuestionProgress(B, 'sec-a31-0001')).toEqual(merged)
    expect(await rawCount('progress')).toBe(2)
  })

  it('repeated import after the replacement is a normal known import (idempotent)', async () => {
    await seedProgress()
    await applyLibraryUpdate(store, aV2().library, { retiredIndex: index })
    const before = await snapshot()

    for (let round = 0; round < 3; round++) {
      const result = await registerLibraryImport(store, aV2().library, { retiredIndex: index, now: 20000 + round })

      expect(result.status).toBe(IMPORT_STATUS.KNOWN)
    }

    const after = await snapshot()

    expect(after.progressA).toEqual(before.progressA)
    expect(after.progressB).toEqual(before.progressB)
    expect(await rawCount('libraries')).toBe(2)
    await expect(applyLibraryUpdate(store, aV2().library, { retiredIndex: index })).rejects.toThrow('Kein Update')
  })

  it('is atomic: a corrupt target record aborts library state, progress and session together', async () => {
    await seedProgress()
    await store.upsertQuestionProgress({
      libraryId: B, questionId: 'sec-a31-0001', attempts: 5, correctCount: 1, incorrectCount: 1, lastResult: 'correct', answered: true, lastAnsweredAt: 1,
    })
    const before = await snapshot()

    await expect(applyLibraryUpdate(store, aV2().library, { retiredIndex: index })).rejects.toThrow(MigrationError)
    expect(await snapshot()).toEqual(before)
  })

  it('is atomic: a write failure in the middle rolls back everything', async () => {
    await seedProgress()
    const before = await snapshot()
    const original = IDBObjectStore.prototype.put
    let calls = 0
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (...args) {
      calls += 1

      if (calls === 2) {
        throw new Error('simulierter Schreibfehler')
      }

      return original.apply(this, args)
    })

    await expect(applyLibraryUpdate(store, aV2().library, { retiredIndex: index })).rejects.toThrow('simulierter Schreibfehler')
    spy.mockRestore()

    expect(calls).toBeGreaterThanOrEqual(2)
    expect(await snapshot()).toEqual(before)
  })

  it('stores and loads the retired index without free text', async () => {
    expect(await store.getRetiredIndex()).toBeNull()
    await store.saveRetiredIndex(index, 5)

    expect(await store.getRetiredIndex()).toEqual(index)
    expect(JSON.stringify(await store.getRetiredIndex())).not.toContain('synthetic')
  })
})

describe('session migration with replacements', () => {
  // Gleiche Library: 0004 wird durch das (neue) 0005 ersetzt.
  const sameLibraryV2 = () => libA({ libraryVersion: '2.0.0', activeQuestionIndexHash: HASH_2, count: 5, omitIds: ['sec-a30-0004'] }).library
  const inheritSame = [{ from: 'sec-a30-0004', to: 'sec-a30-0005', policy: 'inherit', targetLibraryId: A }]
  const resetSame = [{ from: 'sec-a30-0004', to: 'sec-a30-0005', policy: 'reset', targetLibraryId: A }]

  function session(order, { answered = [], correct = [], current = order[0] } = {}) {
    return {
      ...createSessionRecord({ sessionId: 's', library: libA().library, orderedQuestionIds: order }),
      answeredQuestionIds: answered,
      correctQuestionIds: correct,
      sessionCorrectCount: correct.length,
      sessionIncorrectCount: answered.length - correct.length,
      currentStreak: 2,
      bestSessionStreak: 3,
      currentQuestionId: current,
      currentIndex: order.indexOf(current),
    }
  }

  it('inherit: the target takes the slot of the retired question, position and credit stay', () => {
    const base = session(['sec-a30-0003', 'sec-a30-0004', 'sec-a30-0001', 'sec-a30-0002'], {
      answered: ['sec-a30-0003', 'sec-a30-0004'], correct: ['sec-a30-0004'], current: 'sec-a30-0004',
    })
    const result = migrateSessionReplacements(base, sameLibraryV2(), inheritSame)

    expect(result.migrated).toBe(true)
    expect(result.session.orderedQuestionIds).toEqual(['sec-a30-0003', 'sec-a30-0005', 'sec-a30-0001', 'sec-a30-0002'])
    expect(result.session).toMatchObject({
      currentQuestionId: 'sec-a30-0005', currentIndex: 1,
      answeredQuestionIds: ['sec-a30-0003', 'sec-a30-0005'], correctQuestionIds: ['sec-a30-0005'],
      sessionCorrectCount: 1, sessionIncorrectCount: 1,
      // keine Auswahl der alten Frage auf der neuen
      currentQuestionState: { questionId: 'sec-a30-0005', selectedOptionKey: null, optionOrder: null, isCorrect: true },
    })
  })

  it('reset: the target is unanswered and the retired credit is not carried over', () => {
    const base = session(['sec-a30-0003', 'sec-a30-0004', 'sec-a30-0001', 'sec-a30-0002'], {
      answered: ['sec-a30-0003', 'sec-a30-0004'], correct: ['sec-a30-0003', 'sec-a30-0004'], current: 'sec-a30-0004',
    })
    const result = migrateSessionReplacements(base, sameLibraryV2(), resetSame)

    expect(result.session).toMatchObject({
      currentQuestionId: 'sec-a30-0005', answeredQuestionIds: ['sec-a30-0003'], correctQuestionIds: ['sec-a30-0003'],
      sessionCorrectCount: 1, sessionIncorrectCount: 0,
      currentQuestionState: { questionId: 'sec-a30-0005', isCorrect: null },
    })
  })

  it('a target that is already in the round appears only once; its own answer is not doubled', () => {
    const order = ['sec-a30-0004', 'sec-a30-0001', 'sec-a30-0005', 'sec-a30-0002', 'sec-a30-0003']
    const base = {
      ...session(order, { answered: ['sec-a30-0004', 'sec-a30-0001', 'sec-a30-0005'], correct: ['sec-a30-0004', 'sec-a30-0005'], current: 'sec-a30-0005' }),
    }
    const library = libA({ libraryVersion: '2.0.0', activeQuestionIndexHash: HASH_2, count: 5, omitIds: ['sec-a30-0004'] }).library
    const result = migrateSessionReplacements(base, library, inheritSame)

    expect(result.session.orderedQuestionIds).toEqual(['sec-a30-0001', 'sec-a30-0005', 'sec-a30-0002', 'sec-a30-0003'])
    expect(new Set(result.session.orderedQuestionIds).size).toBe(result.session.orderedQuestionIds.length)
    // 0005 war bereits beantwortet: keine zweite Wertung durch die geerbte Retire-Antwort
    expect(result.session.answeredQuestionIds).toEqual(['sec-a30-0001', 'sec-a30-0005'])
    expect(result.session.correctQuestionIds).toEqual(['sec-a30-0005'])
    expect(result.session).toMatchObject({ sessionCorrectCount: 1, sessionIncorrectCount: 1, currentQuestionId: 'sec-a30-0005', currentIndex: 1 })
  })

  it('a dropped current slot moves to the question that follows it, never to a wrong position', () => {
    const order = ['sec-a30-0001', 'sec-a30-0004', 'sec-a30-0002', 'sec-a30-0005', 'sec-a30-0003']
    const base = session(order, { answered: ['sec-a30-0001'], correct: ['sec-a30-0001'], current: 'sec-a30-0004' })
    const library = libA({ libraryVersion: '2.0.0', activeQuestionIndexHash: HASH_2, count: 5, omitIds: ['sec-a30-0004'] }).library
    const result = migrateSessionReplacements(base, library, inheritSame)

    expect(result.session.orderedQuestionIds).toEqual(['sec-a30-0001', 'sec-a30-0002', 'sec-a30-0005', 'sec-a30-0003'])
    expect(result.session).toMatchObject({ currentQuestionId: 'sec-a30-0002', currentIndex: 1 })
  })

  it('does not map to a target in another library: the round stays blocked and stored', () => {
    const base = session(A_IDS, { current: 'sec-a30-0004' })
    const crossLibrary = [{ from: 'sec-a30-0004', to: 'sec-a31-0001', policy: 'inherit', targetLibraryId: B }]
    const result = migrateSessionReplacements(base, aV2().library, crossLibrary)

    expect(result).toMatchObject({ migrated: false, reason: 'unmappable' })
    const reduced = libA({ omitIds: ['sec-a30-0004'] })

    expect(evaluateSession(base, reduced.library, reduced.questions)).toMatchObject({
      status: SESSION_STATUS.RESUME_REQUIRES_MIGRATION, missingQuestionIds: ['sec-a30-0004'],
    })
  })

  it('does not migrate if the library has additional unrelated questions', () => {
    const base = session(A_IDS)
    const bigger = libA({ libraryVersion: '2.0.0', activeQuestionIndexHash: HASH_2, count: 6, omitIds: ['sec-a30-0004'] }).library

    expect(migrateSessionReplacements(base, bigger, inheritSame)).toMatchObject({ migrated: false, reason: 'questionsChanged' })
  })

  it('migrates the stored round in the same transaction as the progress (store)', async () => {
    await setup()
    const base = session(['sec-a30-0003', 'sec-a30-0004', 'sec-a30-0001', 'sec-a30-0002'], { current: 'sec-a30-0004' })

    await store.startNewSession(base)
    await store.recordSessionAnswer({ sessionId: 's', libraryId: A, questionId: 'sec-a30-0004', isCorrect: false, selectedOptionKey: 'c', optionOrder: ['a', 'b', 'c', 'd'] })
    const result = await applyLibraryUpdate(store, sameLibraryV2(), { retiredIndex: parseRetiredIndex({ 'sec-a30-0004': inherit('sec-a30-0005') }) })
    const stored = await store.getLatestSession(A)

    expect(result.sessionMigrated).toBe(true)
    expect(stored.orderedQuestionIds).toContain('sec-a30-0005')
    expect(stored.orderedQuestionIds).not.toContain('sec-a30-0004')
    expect(stored.currentQuestionState.selectedOptionKey).toBeNull()
    expect(await store.getQuestionProgress(A, 'sec-a30-0005')).toMatchObject({ attempts: 1, incorrectCount: 1, inheritedFrom: [{ libraryId: A, questionId: 'sec-a30-0004' }] })
    expect(await rawCount('sessions')).toBe(1)
  })
})
