import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createProgressStore } from '../src/storage/progressStore.js'
import { confirmPendingUpdate, importLibraryBatch } from '../src/storage/catalogImport.js'
import { buildOverview, buildSectionView, readCatalogData, readSectionData } from '../src/storage/sectionService.js'
import { SESSION_STATUS, shuffled } from '../src/domain/session.js'
import { createSectionSessionRecord, evaluateSectionSession, sectionScopeKey } from '../src/domain/sectionSession.js'
import { parseQuestionFile } from '../src/lib/library/parseLibrary.js'
import { makeSyntheticLibrary } from './fixtures/syntheticLibrary.js'

let dbName
let openStores

const hash = (char) => `sha256:${char.repeat(64)}`

function raw(libraryId, { prefix, count = 3, ...options } = {}) {
  return makeSyntheticLibrary({ libraryId, learningSectionId: 'la08', idPrefix: prefix, count, activeQuestionIndexHash: hash(libraryId.length.toString(16).slice(-1)), ...options })
}

const entry = (data, fileName = `${data.libraryId}.json`) => ({ fileName, kind: 'v2', ...parseQuestionFile(data) })

async function newStore() {
  const store = createProgressStore({ dbName })

  openStores.push(store)
  await store.initialize()

  return store
}

beforeEach(() => {
  dbName = `section-db-${Math.random().toString(36).slice(2)}`
  openStores = []
})

afterEach(() => openStores.forEach((store) => store.close()))

// Zwei Libraries (3 + 2 Fragen) im selben Lernabschnitt, Runde über alle 5.
async function setup() {
  const store = await newStore()

  await importLibraryBatch(store, [entry(raw('lib-s-a', { prefix: 'sec-a81' })), entry(raw('lib-s-b', { prefix: 'sec-a82', count: 2 }))])

  const view = buildSectionView(await readSectionData(store, 'la08'))
  const ordered = shuffled(view.questions, () => 0.3)
  const session = createSectionSessionRecord({ sessionId: 'round-1', sectionId: 'la08', libraries: view.libraries, orderedQuestions: ordered })

  await store.startNewSession(session)

  return { store, view, ordered, session }
}

describe('section session identity and content', () => {
  it('uses a deterministic scope key per section and keeps the real question ids', async () => {
    const { store, ordered, session } = await setup()

    expect(session.libraryId).toBe(sectionScopeKey('la08'))
    expect(session.sectionId).toBe('la08')
    expect(session.orderedQuestionIds).toEqual(ordered.map((question) => question.id))
    expect(session.orderedQuestionIds.every((id) => /^sec-a8[12]-\d{4}$/.test(id))).toBe(true)
    expect(session.questionLibraries[session.orderedQuestionIds.find((id) => id.startsWith('sec-a82'))]).toBe('lib-s-b')
    expect(await store.getLatestSectionSession('la08')).toMatchObject({ sessionId: 'round-1' })
    // Keine Sessions unter den echten Library-IDs.
    expect(await store.getLatestSession('lib-s-a')).toBeNull()
  })

  it('persists the shuffled order and current position across store reloads', async () => {
    const { store, session } = await setup()

    await store.advanceSessionTo({ sessionId: 'round-1', questionId: session.orderedQuestionIds[2], optionOrder: ['b', 'a', 'd', 'c'] })
    store.close()

    for (let reload = 0; reload < 3; reload++) {
      const fresh = await newStore()
      const stored = await fresh.getLatestSectionSession('la08')

      expect(stored.orderedQuestionIds).toEqual(session.orderedQuestionIds)
      expect(stored).toMatchObject({ currentQuestionId: session.orderedQuestionIds[2], currentIndex: 2 })
      fresh.close()
    }
  })

  it('records answers per question library, counts each question once, and ignores a wrong library claim', async () => {
    const { store, session } = await setup()
    const [first] = session.orderedQuestionIds
    const owner = session.questionLibraries[first]
    const other = owner === 'lib-s-a' ? 'lib-s-b' : 'lib-s-a'

    const forged = await store.recordSessionAnswer({ sessionId: 'round-1', libraryId: other, questionId: first, isCorrect: true })

    expect(forged.recorded).toBe(false)

    const ok = await store.recordSessionAnswer({ sessionId: 'round-1', libraryId: owner, questionId: first, isCorrect: true })
    const duplicate = await store.recordSessionAnswer({ sessionId: 'round-1', libraryId: owner, questionId: first, isCorrect: true })

    expect(ok.recorded).toBe(true)
    expect(duplicate).toMatchObject({ recorded: false, reason: 'duplicate' })
    expect(await store.getQuestionProgress(owner, first)).toMatchObject({ attempts: 1 })
    expect(await store.getQuestionProgress(other, first)).toBeNull()
    expect((await store.listAllProgress())).toHaveLength(1)
  })
})

describe('section session evaluation (exact resume)', () => {
  it('resumes at the same question and counters', async () => {
    const { store, session } = await setup()

    await store.recordSessionAnswer({ sessionId: 'round-1', libraryId: session.questionLibraries[session.orderedQuestionIds[0]], questionId: session.orderedQuestionIds[0], isCorrect: false, selectedOptionKey: 'a', optionOrder: ['a', 'b', 'c', 'd'] })
    await store.advanceSessionTo({ sessionId: 'round-1', questionId: session.orderedQuestionIds[1], optionOrder: ['d', 'c', 'b', 'a'] })

    const view = buildSectionView(await readSectionData(await newStore(), 'la08'))

    expect(view.evaluation).toMatchObject({
      status: SESSION_STATUS.RESUMABLE,
      currentQuestionId: session.orderedQuestionIds[1],
      currentIndex: 1,
      newQuestionCount: 0,
      stats: { answeredCount: 1, incorrectCount: 1, remainingCount: 4 },
    })
    expect(view.evaluation.currentState.optionOrder).toEqual(['d', 'c', 'b', 'a'])
    expect(view.evaluation.orderedQuestions.map((question) => question.id)).toEqual(session.orderedQuestionIds)
  })

  it('a later import into the same section does not change the running round; new questions join the next round', async () => {
    const { store, session } = await setup()
    const before = await store.getLatestSectionSession('la08')

    await importLibraryBatch(store, [entry(raw('lib-s-c', { prefix: 'sec-a83', count: 4 }))])

    expect(await store.getLatestSectionSession('la08')).toEqual(before)

    const view = buildSectionView(await readSectionData(store, 'la08'))

    expect(view.questions).toHaveLength(9)
    expect(view.evaluation).toMatchObject({ status: SESSION_STATUS.RESUMABLE, newQuestionCount: 4 })
    expect(view.evaluation.orderedQuestions.map((question) => question.id)).toEqual(session.orderedQuestionIds)
    expect(buildOverview(await readCatalogData(store)).sections[0]).toMatchObject({ libraryCount: 3, questionCount: 9, hasResume: true })

    const nextRound = createSectionSessionRecord({ sectionId: 'la08', libraries: view.libraries, orderedQuestions: shuffled(view.questions) })

    expect(nextRound.orderedQuestionIds).toHaveLength(9)
  })

  it('blocks controlled when a round question is no longer active, or its revision changed', async () => {
    const { session } = await setup()
    const active = new Map(session.orderedQuestionIds.map((id) => [id, { id, libraryId: session.questionLibraries[id], contentRevision: 1 }]))

    expect(evaluateSectionSession(session, active).status).toBe(SESSION_STATUS.RESUMABLE)

    const missing = new Map(active)

    missing.delete(session.orderedQuestionIds[0])
    expect(evaluateSectionSession(session, missing)).toMatchObject({ status: SESSION_STATUS.RESUME_REQUIRES_MIGRATION, reason: 'questionsChanged' })

    const revised = new Map(active)

    revised.set(session.orderedQuestionIds[1], { ...active.get(session.orderedQuestionIds[1]), contentRevision: 2 })
    expect(evaluateSectionSession(session, revised)).toMatchObject({ reason: 'revisionsChanged', revisedQuestionIds: [session.orderedQuestionIds[1]] })

    const moved = new Map(active)

    moved.set(session.orderedQuestionIds[0], { ...active.get(session.orderedQuestionIds[0]), libraryId: 'someone-else' })
    expect(evaluateSectionSession(session, moved).reason).toBe('questionsChanged')
    expect(evaluateSectionSession(null, active).status).toBe(SESSION_STATUS.NONE)
    expect(evaluateSectionSession({ ...session, completed: true }, active).status).toBe(SESSION_STATUS.COMPLETED)
  })
})

describe('section round and library updates', () => {
  it('a confirmed revision-only update keeps the round resumable (Phase 2C semantics)', async () => {
    const { store, session } = await setup()
    const revisedId = session.orderedQuestionIds.find((id) => id.startsWith('sec-a81'))
    const update = entry(raw('lib-s-a', { prefix: 'sec-a81', libraryVersion: '1.1.0', activeQuestionIndexHash: hash('d'), contentRevisions: { [revisedId]: 2 } }))
    const batch = await importLibraryBatch(store, [update])

    expect(batch.results[0].status).toBe('updatePending')
    // Vor der Bestätigung blockiert nichts: gespeicherte Fragen und Runde sind unverändert.
    expect(buildSectionView(await readSectionData(store, 'la08')).evaluation.status).toBe(SESSION_STATUS.RESUMABLE)

    await confirmPendingUpdate(store, batch.pending.get('lib-s-a'))

    const view = buildSectionView(await readSectionData(store, 'la08'))

    expect(view.evaluation.status).toBe(SESSION_STATUS.RESUMABLE)
    expect((await store.getLatestSectionSession('la08')).questionRevisions[revisedId]).toBe(2)
    expect((await store.getLatestSectionSession('la08')).orderedQuestionIds).toEqual(session.orderedQuestionIds)
  })

  it('a confirmed replacement update migrates the round with the Phase 2D rules (inherit credit, no double count)', async () => {
    const store = await newStore()

    await importLibraryBatch(store, [
      entry(raw('lib-r-old', { prefix: 'sec-a90', count: 3 })),
      entry(raw('lib-r-new', { prefix: 'sec-a91', count: 2 })),
    ])

    const view = buildSectionView(await readSectionData(store, 'la08'))
    const byId = new Map(view.questions.map((question) => [question.id, question]))
    const order = ['sec-a90-0001', 'sec-a90-0003', 'sec-a91-0001', 'sec-a90-0002']
    let session = createSectionSessionRecord({ sessionId: 'repl', sectionId: 'la08', libraries: view.libraries, orderedQuestions: order.map((id) => byId.get(id)) })

    await store.startNewSession(session)
    await store.recordSessionAnswer({ sessionId: 'repl', libraryId: 'lib-r-old', questionId: 'sec-a90-0001', isCorrect: true })
    await store.recordSessionAnswer({ sessionId: 'repl', libraryId: 'lib-r-old', questionId: 'sec-a90-0003', isCorrect: true })
    await store.advanceSessionTo({ sessionId: 'repl', questionId: 'sec-a91-0001' })
    session = await store.getLatestSectionSession('la08')

    const retiredIndex = parseQuestionFile({
      'sec-a90-0003': { replacedBy: 'sec-a91-0002', progressMigration: 'inherit', learningGoalEquivalence: 'confirmed', reason: 'x' },
    }).retiredIndex
    const reduced = entry(raw('lib-r-old', { prefix: 'sec-a90', count: 3, omitIds: ['sec-a90-0003'], libraryVersion: '2.0.0', activeQuestionIndexHash: hash('6') }))
    const batch = await importLibraryBatch(store, [{ fileName: 'ri.json', kind: 'retiredIndex', retiredIndex }, reduced])

    expect(batch.results.find((result) => result.libraryId === 'lib-r-old').status).toBe('replacementPending')
    await confirmPendingUpdate(store, batch.pending.get('lib-r-old'), { retiredIndex })

    const migrated = await store.getLatestSectionSession('la08')

    // Ziel (in der Runde noch nicht vorhanden) übernimmt den Platz der retired ID; inherit gibt das
    // Rundenguthaben weiter. Das Ziel liegt in einer anderen Library desselben Abschnitts.
    expect(migrated.orderedQuestionIds).toEqual(['sec-a90-0001', 'sec-a91-0002', 'sec-a91-0001', 'sec-a90-0002'])
    expect(migrated.answeredQuestionIds.sort()).toEqual(['sec-a90-0001', 'sec-a91-0002'])
    expect(migrated.sessionCorrectCount).toBe(2)
    expect(migrated.sessionId).toBe(session.sessionId)
    expect(migrated.questionLibraries['sec-a91-0002']).toBe('lib-r-new')
    expect(buildSectionView(await readSectionData(store, 'la08')).evaluation.status).toBe(SESSION_STATUS.RESUMABLE)
  })
})
