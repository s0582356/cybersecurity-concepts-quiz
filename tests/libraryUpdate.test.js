import 'fake-indexeddb/auto'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createProgressStore } from '../src/storage/progressStore.js'
import {
  CHANGE_KIND,
  IMPORT_STATUS,
  applyLibraryUpdate,
  registerLibraryImport,
} from '../src/storage/libraryImport.js'
import {
  SESSION_STATUS,
  applyAnswer,
  createSessionRecord,
  evaluateSession,
  migrateSessionToLibrary,
} from '../src/domain/session.js'
import { parseV2Library } from '../src/lib/library/parseLibrary.js'
import { makeSyntheticLibrary } from './fixtures/syntheticLibrary.js'

const HASH_1 = `sha256:${'a'.repeat(64)}`
const HASH_2 = `sha256:${'b'.repeat(64)}`
const LIBRARY_ID = 'update-test-library'
const IDS = ['sec-a30-0001', 'sec-a30-0002', 'sec-a30-0003', 'sec-a30-0004']

let dbName
let store

function parsed(options = {}) {
  return parseV2Library(makeSyntheticLibrary({ libraryId: LIBRARY_ID, ...options }))
}

async function rawCount(storeName) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName)
    request.onsuccess = () => {
      const database = request.result
      const count = database.transaction(storeName).objectStore(storeName).count()
      count.onsuccess = () => {
        database.close()
        resolve(count.result)
      }
    }
    request.onerror = () => reject(request.error)
  })
}

// Bibliothek importieren, Runde starten, die ersten Fragen beantworten.
async function seed({ answers = 2, ...options } = {}) {
  const { library, questions } = parsed(options)

  await registerLibraryImport(store, library, { now: 1000 })
  await store.startNewSession(
    createSessionRecord({
      sessionId: 'round-1',
      library,
      orderedQuestionIds: IDS,
      optionOrder: ['a', 'b', 'c', 'd'],
      now: 1000,
    }),
  )

  for (let index = 0; index < answers; index++) {
    await store.recordSessionAnswer({
      sessionId: 'round-1',
      libraryId: LIBRARY_ID,
      questionId: IDS[index],
      isCorrect: index % 2 === 0,
      selectedOptionKey: 'b',
      optionOrder: ['a', 'b', 'c', 'd'],
      answeredAtRevision: 1,
    })
  }

  return { library, questions }
}

async function snapshot() {
  return {
    state: await store.getLibraryState(LIBRARY_ID),
    session: await store.getLatestSession(LIBRARY_ID),
    progress: await store.listProgressForLibrary(LIBRARY_ID),
  }
}

beforeEach(async () => {
  dbName = `update-db-${Math.random().toString(36).slice(2)}`
  store = createProgressStore({ dbName })
  await store.initialize()
})

afterEach(() => store.close())

describe('case A: same id, version and hash', () => {
  it('loads normally and keeps progress and session without duplicates', async () => {
    await seed()
    const before = await snapshot()
    const { library } = parsed()

    for (let round = 0; round < 3; round++) {
      const result = await registerLibraryImport(store, library, { now: 2000 + round })

      expect(result.status).toBe(IMPORT_STATUS.KNOWN)
    }

    const after = await snapshot()

    expect(after.progress).toEqual(before.progress)
    expect(after.session).toEqual(before.session)
    expect(after.state).toMatchObject({ libraryVersion: '1.0.0', lastAccessedAt: 2002, firstImportedAt: 1000 })
    expect(await rawCount('libraries')).toBe(1)
    expect(await rawCount('sessions')).toBe(1)
    expect(await rawCount('progress')).toBe(2)
  })
})

describe('case B: new version, same hash', () => {
  it('keeps progress and the active session and updates the library metadata', async () => {
    const { questions } = await seed()
    const before = await snapshot()
    const next = parsed({ libraryVersion: '1.0.1' }).library

    const result = await registerLibraryImport(store, next, { now: 5000 })
    const after = await snapshot()

    expect(result.status).toBe(IMPORT_STATUS.VERSION_UPDATED)
    expect(after.state).toMatchObject({
      libraryVersion: '1.0.1',
      activeQuestionIndexHash: HASH_1,
      lastAccessedAt: 5000,
      updatedAt: 5000,
      firstImportedAt: 1000,
    })
    expect(after.progress).toEqual(before.progress)
    expect(after.session).toEqual(before.session)
    expect(await rawCount('libraries')).toBe(1)

    // Die Runde bleibt exakt fortsetzbar, orderedQuestionIds unverändert.
    const evaluated = evaluateSession(after.session, next, questions)

    expect(evaluated.status).toBe(SESSION_STATUS.RESUMABLE)
    expect(evaluated.orderedQuestions.map((question) => question.id)).toEqual(IDS)
  })

  it('backfills the revision baseline for state written before Phase 2C', async () => {
    const { library } = parsed()
    const { questionRevisions, ...legacyState } = {
      libraryId: LIBRARY_ID, libraryVersion: '1.0.0', activeQuestionIndexHash: HASH_1,
      firstImportedAt: 1, lastAccessedAt: 1, questionRevisions: null,
    }

    await store.upsertLibraryState(legacyState)
    const result = await registerLibraryImport(store, library, { now: 9 })

    expect(result.status).toBe(IMPORT_STATUS.KNOWN)
    expect((await store.getLibraryState(LIBRARY_ID)).questionRevisions).toEqual(library.questionRevisions)
  })
})

describe('case C: other hash', () => {
  const variants = {
    revisionsOnly: [{ libraryVersion: '1.1.0', activeQuestionIndexHash: HASH_2, contentRevisions: { [IDS[1]]: 2 } }, true],
    questionsAdded: [{ libraryVersion: '1.1.0', activeQuestionIndexHash: HASH_2, count: 5 }, true],
    questionsRemoved: [{ libraryVersion: '2.0.0', activeQuestionIndexHash: HASH_2, omitIds: [IDS[3]] }, false],
    revisionsLowered: [{ libraryVersion: '1.1.0', activeQuestionIndexHash: HASH_2, contentRevisions: { [IDS[1]]: 0 } }, false],
    unexpectedHashChange: [{ libraryVersion: '1.0.0', activeQuestionIndexHash: HASH_2 }, false],
  }

  Object.entries(variants).forEach(([kind, [options, compatible]]) => {
    it(`classifies ${kind} and changes nothing stored`, async () => {
      await seed()
      const before = await snapshot()
      let library

      if (kind === 'revisionsLowered') {
        // contentRevision 0 ist ungültig → Ausgangsstand mit Revision 2 anlegen, neue Datei mit 1.
        store.close()
        dbName = `update-db-${Math.random().toString(36).slice(2)}`
        store = createProgressStore({ dbName })
        await store.initialize()
        await seed({ contentRevisions: { [IDS[1]]: 2 } })
        library = parsed({ libraryVersion: '1.1.0', activeQuestionIndexHash: HASH_2 }).library
      } else {
        library = parsed(options).library
      }

      const baseline = kind === 'revisionsLowered' ? await snapshot() : before
      const result = await registerLibraryImport(store, library, { now: 7000 })

      expect(result.status).toBe(IMPORT_STATUS.UPDATE_REQUIRES_MIGRATION)
      expect(result.changeKind).toBe(CHANGE_KIND[{
        revisionsOnly: 'REVISIONS_ONLY',
        questionsAdded: 'QUESTIONS_ADDED',
        questionsRemoved: 'QUESTIONS_REMOVED',
        revisionsLowered: 'REVISIONS_LOWERED',
        unexpectedHashChange: 'UNEXPECTED_HASH_CHANGE',
      }[kind]])
      expect(result.compatible).toBe(compatible)
      expect(await snapshot()).toEqual(baseline)
    })
  })

  it('does not resume the stored session against the changed landscape and does not delete it', async () => {
    const { questions } = await seed()
    const before = await snapshot()
    const changed = parsed({ libraryVersion: '1.1.0', activeQuestionIndexHash: HASH_2, contentRevisions: { [IDS[1]]: 2 } })

    await registerLibraryImport(store, changed.library)

    expect(evaluateSession(before.session, changed.library, changed.questions)).toMatchObject({
      status: SESSION_STATUS.RESUME_REQUIRES_MIGRATION,
      reason: 'hashChanged',
    })
    expect((await snapshot()).session).toEqual(before.session)
    expect(questions).toHaveLength(4)
  })

  it('cannot classify a state without stored revisions (written before Phase 2C)', async () => {
    await store.upsertLibraryState({
      libraryId: LIBRARY_ID, libraryVersion: '1.0.0', activeQuestionIndexHash: HASH_1, firstImportedAt: 1, lastAccessedAt: 1,
    })
    const result = await registerLibraryImport(store, parsed({ libraryVersion: '1.1.0', activeQuestionIndexHash: HASH_2 }).library)

    expect(result).toMatchObject({ changeKind: CHANGE_KIND.UNKNOWN_BASELINE, compatible: false })
  })
})

describe('case D: new libraryId', () => {
  it('creates a separate state, progress and session scope', async () => {
    await seed()
    const other = parseV2Library(makeSyntheticLibrary({ libraryId: 'other-update-library' })).library
    const result = await registerLibraryImport(store, other)

    expect(result.status).toBe(IMPORT_STATUS.NEW)
    expect(await rawCount('libraries')).toBe(2)
    expect(await store.listProgressForLibrary('other-update-library')).toEqual([])
    expect(await store.getLatestSession('other-update-library')).toBeNull()
    expect((await snapshot()).progress).toHaveLength(2)
  })
})

describe('case E: stored session references missing question IDs', () => {
  it('reports resumeRequiresMigration without repairing the session', async () => {
    await seed()
    const reduced = parsed({ omitIds: [IDS[2]] })
    const session = await store.getLatestSession(LIBRARY_ID)

    expect(evaluateSession(session, reduced.library, reduced.questions)).toMatchObject({
      status: SESSION_STATUS.RESUME_REQUIRES_MIGRATION,
      missingQuestionIds: [IDS[2]],
    })
    expect(await store.getLatestSession(LIBRARY_ID)).toEqual(session)
  })

  it('notices changed revisions even if the hash was copied unchanged (defense in depth)', async () => {
    await seed()
    const tampered = parsed({ contentRevisions: { [IDS[1]]: 3 } })
    const session = await store.getLatestSession(LIBRARY_ID)

    expect(evaluateSession(session, tampered.library, tampered.questions)).toMatchObject({
      status: SESSION_STATUS.RESUME_REQUIRES_MIGRATION,
      reason: 'revisionsChanged',
      revisedQuestionIds: [IDS[1]],
    })
  })
})

describe('confirmed update of a compatible change', () => {
  it('revisionsOnly: keeps all progress, migrates the running round without reordering', async () => {
    await seed()
    const before = await snapshot()
    const update = parsed({ libraryVersion: '1.1.0', activeQuestionIndexHash: HASH_2, contentRevisions: { [IDS[1]]: 2 } })

    const result = await applyLibraryUpdate(store, update.library, { now: 8000 })
    const after = await snapshot()

    expect(result.sessionMigrated).toBe(true)
    expect(after.state).toMatchObject({ libraryVersion: '1.1.0', activeQuestionIndexHash: HASH_2, updatedAt: 8000 })
    expect(after.state.questionRevisions[IDS[1]]).toBe(2)
    // Progress unverändert: kein Löschen, keine Duplikate, kein Neuschreiben.
    expect(after.progress).toEqual(before.progress)
    expect(after.session.orderedQuestionIds).toEqual(before.session.orderedQuestionIds)
    expect(after.session.answeredQuestionIds).toEqual(before.session.answeredQuestionIds)
    expect(evaluateSession(after.session, update.library, update.questions).status).toBe(SESSION_STATUS.RESUMABLE)

    // Idempotent: nochmal importieren ist ein normaler bekannter Import, erneutes Übernehmen scheitert.
    expect((await registerLibraryImport(store, update.library)).status).toBe(IMPORT_STATUS.KNOWN)
    await expect(applyLibraryUpdate(store, update.library)).rejects.toThrow('Kein Update')
    expect(await rawCount('libraries')).toBe(1)
    expect(await rawCount('sessions')).toBe(1)
    expect(await rawCount('progress')).toBe(2)
  })

  it('questionsAdded: adds no progress and leaves the running round blocked and stored', async () => {
    await seed()
    const before = await snapshot()
    const update = parsed({ libraryVersion: '1.1.0', activeQuestionIndexHash: HASH_2, count: 5 })

    const result = await applyLibraryUpdate(store, update.library)
    const after = await snapshot()

    expect(result.sessionMigrated).toBe(false)
    expect(after.progress).toEqual(before.progress)
    expect(after.progress.some((record) => record.questionId === 'sec-a30-0005')).toBe(false)
    expect(after.session).toEqual(before.session)
    expect(evaluateSession(after.session, update.library, update.questions).status).toBe(
      SESSION_STATUS.RESUME_REQUIRES_MIGRATION,
    )
  })

  it('refuses incompatible changes and stale expectations without writing', async () => {
    await seed()
    const before = await snapshot()
    const removed = parsed({ libraryVersion: '2.0.0', activeQuestionIndexHash: HASH_2, omitIds: [IDS[3]] }).library

    await expect(applyLibraryUpdate(store, removed)).rejects.toThrow()
    await expect(
      store.applyCompatibleUpdate({ library: removed, previousHash: HASH_2 }),
    ).rejects.toThrow()
    expect(await snapshot()).toEqual(before)
  })
})

describe('same question ID, new contentRevision', () => {
  it('stores the revision of the answer; progress survives a revision update', async () => {
    await seed()
    const before = (await snapshot()).progress.find((record) => record.questionId === IDS[1])

    expect(before).toMatchObject({ attempts: 1, answeredAtRevision: 1 })

    await applyLibraryUpdate(
      store,
      parsed({ libraryVersion: '1.1.0', activeQuestionIndexHash: HASH_2, contentRevisions: { [IDS[1]]: 2 } }).library,
    )
    await store.recordSessionAnswer({
      sessionId: 'round-1', libraryId: LIBRARY_ID, questionId: IDS[2], isCorrect: true, answeredAtRevision: 1,
    })
    await store.recordAnswer({ libraryId: LIBRARY_ID, questionId: IDS[1], isCorrect: true, answeredAtRevision: 2 })

    const after = await store.getQuestionProgress(LIBRARY_ID, IDS[1])

    // Zähler laufen weiter, nur die Revision der letzten Antwort ändert sich.
    expect(after).toMatchObject({ attempts: 2, correctCount: 1, incorrectCount: 1, answeredAtRevision: 2 })
  })

  it('leaves answeredAtRevision unset when no revision is known', async () => {
    const record = await store.recordAnswer({ libraryId: LIBRARY_ID, questionId: IDS[0], isCorrect: true })

    expect('answeredAtRevision' in record).toBe(false)
  })

  it('does not reuse the old UI response of a revised current question', () => {
    const { library, session } = (() => {
      const { library: lib } = parsed({ libraryVersion: '1.1.0', activeQuestionIndexHash: HASH_2, contentRevisions: { [IDS[0]]: 2 } })
      const base = createSessionRecord({
        sessionId: 's', library: parsed().library, orderedQuestionIds: IDS, optionOrder: ['d', 'c', 'b', 'a'],
      })

      return { library: lib, session: applyAnswer(base, { questionId: IDS[0], isCorrect: false, selectedOptionKey: 'c' }).session }
    })()

    const revised = migrateSessionToLibrary(session, library, [IDS[0]])
    const untouched = migrateSessionToLibrary(session, library, [IDS[3]])

    expect(revised.migrated).toBe(true)
    expect(revised.session.currentQuestionState).toEqual({
      questionId: IDS[0], optionOrder: null, selectedOptionKey: null, isCorrect: false,
    })
    // Nicht überarbeitete Frage: Zustand bleibt (gleicher Inhalt, gleiche Question-ID).
    expect(untouched.session.currentQuestionState).toMatchObject({ selectedOptionKey: 'c', optionOrder: ['d', 'c', 'b', 'a'] })
    expect(revised.session.answeredQuestionIds).toEqual([IDS[0]])
  })

  it('does not migrate a round whose question IDs changed', () => {
    const base = createSessionRecord({ sessionId: 's', library: parsed().library, orderedQuestionIds: IDS })
    const added = parsed({ libraryVersion: '1.1.0', activeQuestionIndexHash: HASH_2, count: 5 }).library

    expect(migrateSessionToLibrary(base, added, [])).toEqual({ migrated: false, session: base })
  })
})

describe('real library history (optional, local only)', () => {
  const previous = process.env.V2_PILOT_PREVIOUS_LIBRARY_PATH
  const current = process.env.V2_PILOT_LIBRARY_PATH

  it.skipIf(!previous || !current)('1.0.0 → 1.0.1 with the same hash keeps progress and session', async () => {
    const before = parseV2Library(JSON.parse(readFileSync(previous, 'utf8')))
    const after = parseV2Library(JSON.parse(readFileSync(current, 'utf8')))
    const ids = before.questions.map((question) => question.id)

    await registerLibraryImport(store, before.library, { now: 1 })
    await store.startNewSession(createSessionRecord({ sessionId: 'real', library: before.library, orderedQuestionIds: ids }))
    await store.recordSessionAnswer({ sessionId: 'real', libraryId: before.library.libraryId, questionId: ids[0], isCorrect: true })

    const result = await registerLibraryImport(store, after.library, { now: 2 })
    const session = await store.getLatestSession(after.library.libraryId)

    expect(before.library.libraryVersion).toBe('1.0.0')
    expect(after.library.libraryVersion).toBe('1.0.1')
    expect(result.status).toBe(IMPORT_STATUS.VERSION_UPDATED)
    expect(evaluateSession(session, after.library, after.questions).status).toBe(SESSION_STATUS.RESUMABLE)
    expect(await store.listProgressForLibrary(after.library.libraryId)).toHaveLength(1)
  })
})
