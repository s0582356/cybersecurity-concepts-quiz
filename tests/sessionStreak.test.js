import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createProgressStore } from '../src/storage/progressStore.js'
import { applyLibraryUpdate, registerLibraryImport } from '../src/storage/libraryImport.js'
import { parseRetiredIndex } from '../src/domain/replacementMigration.js'
import { applyAnswer, createSessionRecord, deriveStreaks, migrateSessionReplacements } from '../src/domain/session.js'
import { parseV2Library } from '../src/lib/library/parseLibrary.js'
import { makeSyntheticLibrary } from './fixtures/syntheticLibrary.js'

const LIB = 'streak-lib'
const HASH_2 = `sha256:${'5'.repeat(64)}`
const id = (number) => `sec-a30-${String(number).padStart(4, '0')}`

// Library v2: Frage 4 entfällt, Frage 5 (neu) ersetzt sie in derselben Library.
const libraryV1 = () => parseV2Library(makeSyntheticLibrary({ libraryId: LIB, count: 4 })).library
const libraryV2 = () =>
  parseV2Library(makeSyntheticLibrary({ libraryId: LIB, count: 5, libraryVersion: '2.0.0', activeQuestionIndexHash: HASH_2, omitIds: [id(4)] })).library
const replacement = (policy) => [{ from: id(4), to: id(5), policy, targetLibraryId: LIB }]

// Session mit chronologischem Antwortverlauf, erzeugt über die echte Antwortregel.
function sessionWith(order, answers, current) {
  let session = createSessionRecord({ sessionId: 's', library: libraryV1(), orderedQuestionIds: order })

  for (const [questionId, isCorrect] of answers) {
    session = applyAnswer(session, { questionId, isCorrect }).session
  }

  return current ? { ...session, currentQuestionId: current, currentIndex: order.indexOf(current) } : session
}

const streaks = (session) => ({ current: session.currentStreak, best: session.bestSessionStreak })

describe('deriveStreaks', () => {
  it('reproduces the live streak rule from the answer history', () => {
    const session = sessionWith(
      [id(1), id(2), id(3), id(4)],
      [[id(1), true], [id(2), true], [id(3), false], [id(4), true]],
    )

    expect(deriveStreaks(session.answeredQuestionIds, session.correctQuestionIds)).toEqual({
      currentStreak: session.currentStreak,
      bestSessionStreak: session.bestSessionStreak,
    })
    expect(streaks(session)).toEqual({ current: 1, best: 2 })
    expect(deriveStreaks([], [])).toEqual({ currentStreak: 0, bestSessionStreak: 0 })
  })
})

describe('streaks after a same-library replacement', () => {
  it('reset of a correct retire answer in the middle: current and best drop with the removed credit', () => {
    // Verlauf: 1 ✓, 2 ✓, 4 ✓ (retire), 3 ✓ → 4/4 vor der Migration
    const order = [id(1), id(2), id(4), id(3)]
    const before = sessionWith(order, [[id(1), true], [id(2), true], [id(4), true], [id(3), true]])

    expect(streaks(before)).toEqual({ current: 4, best: 4 })

    const { session } = migrateSessionReplacements(before, libraryV2(), replacement('reset'))

    expect(session.answeredQuestionIds).toEqual([id(1), id(2), id(3)])
    expect(session).toMatchObject({ sessionCorrectCount: 3, sessionIncorrectCount: 0 })
    expect(streaks(session)).toEqual({ current: 3, best: 3 })
  })

  it('reset of a correct retire answer at the end of the history (it was the current question)', () => {
    const order = [id(1), id(2), id(3), id(4)]
    const before = sessionWith(order, [[id(1), true], [id(2), true], [id(3), true], [id(4), true]], id(4))
    const { session } = migrateSessionReplacements(before, libraryV2(), replacement('reset'))

    expect(session).toMatchObject({ currentQuestionId: id(5), currentIndex: 3 })
    expect(session.answeredQuestionIds).toEqual([id(1), id(2), id(3)])
    expect(streaks(session)).toEqual({ current: 3, best: 3 })
  })

  it('best session streak does not stay artificially high if the best run consisted of the removed answer', () => {
    // 1 ✓, 4 ✓ (retire), 2 ✓ ergibt best 3; danach 3 ✗ und 1 weitere ✓ → current 1
    const order = [id(1), id(4), id(2), id(3)]
    const before = sessionWith(order, [[id(1), true], [id(4), true], [id(2), true], [id(3), false]])

    expect(streaks(before)).toEqual({ current: 0, best: 3 })

    const { session } = migrateSessionReplacements(before, libraryV2(), replacement('reset'))

    expect(streaks(session)).toEqual({ current: 0, best: 2 })
  })

  it('reset of a wrong retire answer creates no false streak and keeps breaks that remain', () => {
    // 1 ✓, 4 ✗ (retire), 2 ✓, 3 ✗, … → Verlauf nach dem Entfernen: 1 ✓, 2 ✓, 3 ✗
    const order = [id(1), id(4), id(2), id(3)]
    const before = sessionWith(order, [[id(1), true], [id(4), false], [id(2), true], [id(3), false]])
    const { session } = migrateSessionReplacements(before, libraryV2(), replacement('reset'))

    expect(session).toMatchObject({ sessionCorrectCount: 2, sessionIncorrectCount: 1 })
    // 3 ✗ bleibt ein Bruch: aktuelle Serie 0; die Serie zählt nur den noch vorhandenen Verlauf (1 ✓, 2 ✓)
    expect(streaks(session)).toEqual({ current: 0, best: 2 })
  })

  it('reset of a wrong answer in the middle joins the surrounding correct answers only through remaining history', () => {
    const order = [id(1), id(4), id(2), id(3)]
    const before = sessionWith(order, [[id(1), true], [id(4), false], [id(2), true], [id(3), true]])

    expect(streaks(before)).toEqual({ current: 2, best: 2 })
    expect(streaks(migrateSessionReplacements(before, libraryV2(), replacement('reset')).session)).toEqual({ current: 3, best: 3 })
  })

  it('inherit keeps the credit at the same history position, so the streak is unchanged', () => {
    const order = [id(1), id(2), id(4), id(3)]
    const before = sessionWith(order, [[id(1), true], [id(2), true], [id(4), true], [id(3), true]])
    const { session } = migrateSessionReplacements(before, libraryV2(), replacement('inherit'))

    expect(session.answeredQuestionIds).toEqual([id(1), id(2), id(5), id(3)])
    expect(streaks(session)).toEqual({ current: 4, best: 4 })
    expect(streaks(session)).toEqual(streaks(before))
  })

  it('inherit of a wrong answer keeps the break', () => {
    const order = [id(1), id(4), id(2), id(3)]
    const before = sessionWith(order, [[id(1), true], [id(4), false], [id(2), true], [id(3), true]])
    const { session } = migrateSessionReplacements(before, libraryV2(), replacement('inherit'))

    expect(streaks(session)).toEqual(streaks(before))
    expect(streaks(session)).toEqual({ current: 2, best: 2 })
  })

  it('duplicate target: the dropped retire credit does not count, the target keeps its own position in the history', () => {
    // 5 war bereits in der Runde und beantwortet; 4 (retire) wird beantwortet und fällt weg
    const order = [id(1), id(5), id(4), id(2), id(3)]
    const before = sessionWith(order, [[id(1), true], [id(5), true], [id(4), true], [id(2), false]])

    expect(streaks(before)).toEqual({ current: 0, best: 3 })

    const { session } = migrateSessionReplacements(before, libraryV2(), replacement('inherit'))

    expect(session.orderedQuestionIds).toEqual([id(1), id(5), id(2), id(3)])
    expect(session.answeredQuestionIds).toEqual([id(1), id(5), id(2)])
    expect(streaks(session)).toEqual({ current: 0, best: 2 })
  })

  it('a replacement that touches no answered question keeps the existing streaks', () => {
    const order = [id(1), id(2), id(3), id(4)]
    const before = sessionWith(order, [[id(1), true], [id(2), true]], id(3))
    const { session } = migrateSessionReplacements(before, libraryV2(), replacement('reset'))

    expect(streaks(session)).toEqual(streaks(before))
    expect(streaks(session)).toEqual({ current: 2, best: 2 })
  })

  it('a second migration is a no-op with the same streak values', () => {
    const order = [id(1), id(2), id(4), id(3)]
    const before = sessionWith(order, [[id(1), true], [id(2), true], [id(4), true], [id(3), true]])
    const first = migrateSessionReplacements(before, libraryV2(), replacement('reset'))
    const second = migrateSessionReplacements(first.session, libraryV2(), replacement('reset'))

    expect(second.migrated).toBe(true)
    expect(second.session).toEqual(first.session)
    expect(streaks(second.session)).toEqual({ current: 3, best: 3 })
  })
})

describe('streaks after a replacement through the store', () => {
  let store
  let dbName

  beforeEach(async () => {
    dbName = `streak-db-${Math.random().toString(36).slice(2)}`
    store = createProgressStore({ dbName })
    await store.initialize()
  })

  afterEach(() => store.close())

  it('persists the corrected streaks, survives a reload and does not change on a second run', async () => {
    const order = [id(1), id(2), id(4), id(3)]
    const retired = parseRetiredIndex({ [id(4)]: { replacedBy: id(5), progressMigration: 'reset' } })

    await registerLibraryImport(store, libraryV1(), { now: 1 })
    await store.startNewSession(createSessionRecord({ sessionId: 'streak', library: libraryV1(), orderedQuestionIds: order }))

    for (const questionId of [id(1), id(2), id(4)]) {
      await store.recordSessionAnswer({ sessionId: 'streak', libraryId: LIB, questionId, isCorrect: true })
    }

    expect(streaks(await store.getLatestSession(LIB))).toEqual({ current: 3, best: 3 })

    const result = await applyLibraryUpdate(store, libraryV2(), { retiredIndex: retired })

    expect(result.sessionMigrated).toBe(true)
    expect(streaks(await store.getLatestSession(LIB))).toEqual({ current: 2, best: 2 })

    // Reload: neue Store-Instanz liest dieselben Werte
    store.close()
    store = createProgressStore({ dbName })
    await store.initialize()
    const reloaded = await store.getLatestSession(LIB)

    expect(streaks(reloaded)).toEqual({ current: 2, best: 2 })
    expect(reloaded.answeredQuestionIds).toEqual([id(1), id(2)])

    // zweiter Lauf: Update nicht mehr anwendbar, Ersetzung ein No-op, Session unverändert
    await expect(applyLibraryUpdate(store, libraryV2(), { retiredIndex: retired })).rejects.toThrow('Kein Update')
    await store.applyReplacementMigration({ libraryId: LIB, replacements: replacement('reset') })
    expect(await store.getLatestSession(LIB)).toEqual(reloaded)

    // Weiterspielen nach der Migration setzt die abgeleitete Serie fort (richtig → 3)
    await store.recordSessionAnswer({ sessionId: 'streak', libraryId: LIB, questionId: id(5), isCorrect: true })
    expect(streaks(await store.getLatestSession(LIB))).toEqual({ current: 3, best: 3 })
  })
})
