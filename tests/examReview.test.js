import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProgressStore } from '../src/storage/progressStore.js'
import { parseV2Library } from '../src/lib/library/parseLibrary.js'
import { createSessionRecord } from '../src/domain/session.js'
import { createExamAttempt, finalizeExamAttemptRecord, validateExamAttempt, EXAM_STATUS } from '../src/domain/examAttempt.js'
import { REVIEW_PROBLEM, REVIEW_STATUS, buildExamReview, pickLastExamResult } from '../src/domain/examReview.js'
import { readExamPool, startExam } from '../src/storage/examService.js'
import { clone, deepFreeze, importExamLibraries, makeExamLibraryData, seededRandom } from './fixtures/examFixtures.js'

// Phase 3D: Review-Modell (Snapshot-Quelle), "letztes Ergebnis" und das Verwerfen eines laufenden Versuchs.

const SIZES = { la01: 12, la02: 20, la03: 8 }

let dbName
let openStores

async function readyStore() {
  const store = createProgressStore({ dbName })

  openStores.push(store)
  await store.initialize()
  await importExamLibraries(store, makeExamLibraryData(SIZES))

  return store
}

const correctKey = (attempt, id) => attempt.questionSnapshots[id].correctOptionKey
const wrongKey = (attempt, id) => ['a', 'b', 'c', 'd'].find((key) => key !== correctKey(attempt, id))

async function pooled(options = {}) {
  const store = await readyStore()
  const { pool, libraries } = await readExamPool(store)

  return { store, pool, libraries, make: (extra = {}) => createExamAttempt({ pool, libraries, count: 12, random: seededRandom(3), now: 1000, ...options, ...extra }) }
}

// Antwortplan je Position: 'c' richtig, 'w' falsch, '-' unbeantwortet.
function answered(attempt, plan) {
  const answers = {}

  attempt.orderedQuestionIds.forEach((id, index) => {
    const mark = plan[index % plan.length]

    if (mark === 'c') answers[id] = correctKey(attempt, id)
    if (mark === 'w') answers[id] = wrongKey(attempt, id)
  })

  return { ...attempt, answers }
}

const submitted = (attempt, plan = ['c', 'w', '-'], now = 5000) => finalizeExamAttemptRecord(answered(attempt, plan), now).attempt

beforeEach(() => {
  dbName = `exam-review-db-${Math.random().toString(36).slice(2)}`
  openStores = []
})

afterEach(() => {
  openStores.forEach((store) => store.close())
  vi.restoreAllMocks()
})

describe('buildExamReview', () => {
  it('derives status only from the stored answer and the snapshot correctOptionKey (correct / incorrect / unanswered)', async () => {
    const { make } = await pooled()
    const done = submitted(make(), ['c', 'w', '-'])
    const outcome = buildExamReview(done)

    expect(outcome.ok).toBe(true)

    const { items } = outcome.review

    expect(items.map((item) => item.status)).toEqual(items.map((_, index) => [REVIEW_STATUS.CORRECT, REVIEW_STATUS.INCORRECT, REVIEW_STATUS.UNANSWERED][index % 3]))

    items.forEach((item) => {
      const snapshot = done.questionSnapshots[item.id]

      expect(item.correctKey).toBe(snapshot.correctOptionKey)
      expect(item.selectedKey).toBe(done.answers[item.id] ?? null)
      expect(item.options.filter((option) => option.correct).map((option) => option.key)).toEqual([snapshot.correctOptionKey])
      expect(item.options.filter((option) => option.selected).map((option) => option.key)).toEqual(item.selectedKey ? [item.selectedKey] : [])
    })
  })

  it('keeps exactly the stored option order and the snapshot texts (no resorting, no live content)', async () => {
    const { make } = await pooled()
    const done = submitted(make())
    const { review } = buildExamReview(done)

    review.items.forEach((item) => {
      expect(item.options.map((option) => option.key)).toEqual(done.optionOrder[item.id])
      expect(item.options.map((option) => option.text)).toEqual(done.optionOrder[item.id].map((key) => done.questionSnapshots[item.id].content.optionText[key]))
      expect(item.text).toBe(done.questionSnapshots[item.id].content.question)
      expect(item.explanation).toBe(done.questionSnapshots[item.id].content.explanation)
      expect(item.memoryAid).toEqual(done.questionSnapshots[item.id].content.memoryAid)
    })
    expect(review.items.map((item) => item.id)).toEqual(done.orderedQuestionIds)
  })

  it('judges by key, not by display position: a different option order does not change the verdict', async () => {
    const { make } = await pooled()
    const base = submitted(make(), ['c'])
    const id = base.orderedQuestionIds[0]
    // gleiche Antwortschlüssel, andere Anzeigereihenfolge
    const reordered = { ...base, optionOrder: { ...base.optionOrder, [id]: [...base.optionOrder[id]].reverse() } }
    const item = buildExamReview(reordered).review.items[0]

    expect(item.status).toBe(REVIEW_STATUS.CORRECT)
    expect(item.options.map((option) => option.key)).toEqual([...base.optionOrder[id]].reverse())
  })

  it('does not recompute or expose the result: the summary stays attempt.result', async () => {
    const { make } = await pooled()
    const done = submitted(make())
    const { review } = buildExamReview(done)

    expect(Object.keys(review).sort()).toEqual(['examSessionId', 'items', 'language', 'questionCount'])
    expect(JSON.stringify(review)).not.toContain('percent')
  })

  it('refuses a running attempt: no solutions, explanations or memory aids', async () => {
    const { make } = await pooled()
    const running = answered(make(), ['c', 'w'])
    const outcome = buildExamReview(running)

    expect(outcome).toEqual({ ok: false, reason: REVIEW_PROBLEM.NOT_SUBMITTED })
    expect(JSON.stringify(outcome)).not.toMatch(/explanation|memoryAid|correct/)
  })

  it('reports an invalid completed attempt as unavailable instead of inventing data', async () => {
    const { make } = await pooled()
    const done = submitted(make())
    const broken = [
      { ...done, result: { ...done.result, percent: done.result.percent + 1 } },
      { ...done, completedAt: null },
      { ...done, orderedQuestionIds: done.orderedQuestionIds.slice(1) },
    ]

    broken.forEach((attempt) => expect(buildExamReview(attempt)).toEqual({ ok: false, reason: REVIEW_PROBLEM.INVALID }))
    expect(buildExamReview(null)).toEqual({ ok: false, reason: REVIEW_PROBLEM.INVALID })
  })

  it('has no live-content fallback when a snapshot field is missing or malformed', async () => {
    const { make } = await pooled()
    const done = submitted(make())
    const id = done.orderedQuestionIds[2]
    const without = (field) => {
      const copy = clone(done)

      delete copy.questionSnapshots[id].content[field]

      return copy
    }
    const cases = [without('explanation'), without('question'), without('optionText')]
    const noSnapshot = clone(done)

    delete noSnapshot.questionSnapshots[id]
    cases.push(noSnapshot)

    const noCorrectKey = clone(done)

    delete noCorrectKey.questionSnapshots[id].correctOptionKey
    cases.push(noCorrectKey)

    const badAid = clone(done)

    badAid.questionSnapshots[id].content.memoryAid = { type: 'mnemonic' }
    cases.push(badAid)

    cases.forEach((attempt) => expect(buildExamReview(attempt)).toEqual({ ok: false, reason: REVIEW_PROBLEM.INVALID }))
  })

  it('passes memoryAid.type through unchanged and returns null when the snapshot has no memory aid', async () => {
    const { make } = await pooled()
    const base = make()
    const [first, second] = base.orderedQuestionIds
    const adjusted = clone(base)

    adjusted.questionSnapshots[first].content.memoryAid = { type: 'exam_trap', text: 'Falle' }
    adjusted.questionSnapshots[second].content.memoryAid = null

    const { review } = buildExamReview(submitted(adjusted))

    expect(review.items[0].memoryAid).toEqual({ type: 'exam_trap', text: 'Falle' })
    expect(review.items[1].memoryAid).toBeNull()
  })

  it('does not mutate a frozen attempt', async () => {
    const { make } = await pooled()
    const frozen = deepFreeze(clone(submitted(make())))

    expect(() => buildExamReview(frozen)).not.toThrow()
  })
})

describe('pickLastExamResult', () => {
  const record = (examSessionId, completedAt, extra = {}) => ({ examSessionId, status: EXAM_STATUS.SUBMITTED, completedAt, sessionStartedAt: 100, ...extra })

  it('returns null without any submitted attempt', () => {
    expect(pickLastExamResult([])).toBeNull()
    expect(pickLastExamResult([{ examSessionId: 'r', status: EXAM_STATUS.IN_PROGRESS, completedAt: null, sessionStartedAt: 1 }])).toBeNull()
  })

  it('picks the submitted attempt with the newest completedAt, independent of input order', () => {
    const list = [record('a', 300), record('b', 900), record('c', 500)]
    const permutations = [list, [...list].reverse(), [list[1], list[0], list[2]], [list[2], list[1], list[0]]]

    permutations.forEach((input) => expect(pickLastExamResult(input)).toEqual({ examSessionId: 'b', completedAt: 900 }))
  })

  it('ignores running attempts, even if they are newer', () => {
    const list = [record('done', 400), { examSessionId: 'running', status: EXAM_STATUS.IN_PROGRESS, completedAt: null, sessionStartedAt: 9999 }]

    expect(pickLastExamResult(list).examSessionId).toBe('done')
  })

  it('breaks ties by the later start, then by the larger id (stable, never random)', () => {
    const byStart = [record('a', 500, { sessionStartedAt: 100 }), record('b', 500, { sessionStartedAt: 200 })]

    expect(pickLastExamResult(byStart).examSessionId).toBe('b')
    expect(pickLastExamResult([...byStart].reverse()).examSessionId).toBe('b')

    const byId = [record('exam-1', 500), record('exam-3', 500), record('exam-2', 500)]

    expect(pickLastExamResult(byId).examSessionId).toBe('exam-3')
    expect(pickLastExamResult([...byId].reverse()).examSessionId).toBe('exam-3')
  })

  it('does not consider submitted records without a valid completedAt', () => {
    const list = [record('bad1', null), record('bad2', 'x'), record('bad3', NaN), record('ok', 10)]

    expect(pickLastExamResult(list).examSessionId).toBe('ok')
  })

  it('does not skip a damaged but newest completed record (otherwise an older result would pose as the last one)', () => {
    const list = [record('older', 100), record('newest-damaged', 900)]

    expect(pickLastExamResult(list).examSessionId).toBe('newest-damaged')
  })
})

describe('discardActiveExamAttempt (store)', () => {
  async function running(store, language = 'de') {
    const { started, attempt } = await startExam(store, { count: 12, language, random: seededRandom(5), now: 1000 })

    expect(started).toBe(true)

    return attempt
  }

  it('deletes a running attempt so that it is no longer active and a new one can start', async () => {
    const store = await readyStore()
    const attempt = await running(store)

    expect(await store.discardActiveExamAttempt(attempt.examSessionId)).toEqual({ discarded: true })
    expect(await store.getExamAttempt(attempt.examSessionId)).toBeNull()
    expect(await store.getActiveExamAttempt()).toBeNull()
    expect(await store.listExamAttempts()).toEqual([])
    expect((await startExam(store, { count: 12, random: seededRandom(6), now: 2000 })).started).toBe(true)
  })

  it('never deletes or changes a submitted attempt', async () => {
    const store = await readyStore()
    const attempt = await running(store)

    await store.recordExamAnswer({ examSessionId: attempt.examSessionId, questionId: attempt.orderedQuestionIds[0], selectedOptionKey: 'a' })

    const { attempt: done } = await store.finalizeExamAttempt(attempt.examSessionId, 3000)

    expect(await store.discardActiveExamAttempt(attempt.examSessionId)).toEqual({ discarded: false, reason: 'notActive' })
    expect(await store.getExamAttempt(attempt.examSessionId)).toEqual(done)
  })

  it('reports a missing attempt without writing', async () => {
    const store = await readyStore()

    expect(await store.discardActiveExamAttempt('does-not-exist')).toEqual({ discarded: false, reason: 'notFound' })
  })

  it('can discard a damaged running attempt (raw status only)', async () => {
    const store = await readyStore()
    const attempt = await running(store)
    const database = await new Promise((resolve) => {
      const request = indexedDB.open(dbName)

      request.onsuccess = () => resolve(request.result)
    })

    await new Promise((resolve) => {
      const transaction = database.transaction('examAttempts', 'readwrite')

      transaction.objectStore('examAttempts').put({ ...attempt, currentIndex: 999 })
      transaction.oncomplete = resolve
    })
    database.close()

    expect(await store.discardActiveExamAttempt(attempt.examSessionId)).toEqual({ discarded: true })
    expect(await store.getActiveExamAttempt()).toBeNull()
  })

  it('is atomic against a concurrent submit: either the result survives unchanged or the attempt is gone, never a half state', async () => {
    for (let round = 0; round < 6; round++) {
      const store = await readyStore()
      const attempt = await running(store)
      const id = attempt.examSessionId
      let finalized
      let discarded

      // Start-Reihenfolge wechselt je Runde: beide Gewinner-Fälle werden abgedeckt.
      if (round % 2) {
        const pendingDiscard = store.discardActiveExamAttempt(id)
        const pendingFinalize = store.finalizeExamAttempt(id, 4000)

        ;[discarded, finalized] = await Promise.all([pendingDiscard, pendingFinalize])
      } else {
        const pendingFinalize = store.finalizeExamAttempt(id, 4000)
        const pendingDiscard = store.discardActiveExamAttempt(id)

        ;[finalized, discarded] = await Promise.all([pendingFinalize, pendingDiscard])
      }

      const stored = await store.getExamAttempt(attempt.examSessionId)

      if (discarded.discarded) {
        expect(stored).toBeNull()
        expect(finalized).toMatchObject({ finalized: false, reason: 'notFound' })
      } else {
        expect(discarded.reason).toBe('notActive')
        expect(stored).toMatchObject({ status: EXAM_STATUS.SUBMITTED })
        expect(stored).toEqual(finalized.attempt)
      }

      store.close()
      dbName = `exam-review-db-${Math.random().toString(36).slice(2)}`
    }
  })

  it('opens only the examAttempts store and leaves learning data untouched', async () => {
    const store = await readyStore()
    const { library, questions } = parseV2Library(makeExamLibraryData(SIZES)[0])

    await store.startNewSession(
      createSessionRecord({ sessionId: 'learn-1', library, orderedQuestionIds: questions.map((question) => question.id), optionOrder: ['a', 'b', 'c', 'd'], now: 500 }),
    )

    const learning = async () => ({ progress: await store.listAllProgress(), sections: await store.listSectionSessions(), states: await store.listLibraryStates() })
    const before = await learning()
    const attempt = await running(store)
    const original = IDBDatabase.prototype.transaction
    const opened = []

    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (names, mode) {
      opened.push([names].flat().join(','))

      return original.call(this, names, mode)
    })
    await store.discardActiveExamAttempt(attempt.examSessionId)
    vi.restoreAllMocks()

    expect(new Set(opened)).toEqual(new Set(['examAttempts']))
    expect(await learning()).toEqual(before)
  })
})

// --- Phase-3D-Narrow-Fix: P3D-RT-001 (kein Pfad löscht abgegebene Versuche) -----------------------------------------

describe('completed attempts cannot be deleted by any exported store method (P3D-RT-001)', () => {
  async function completed(store, seed = 5) {
    const { attempt } = await startExam(store, { count: 12, random: seededRandom(seed), now: 1000 })

    await store.recordExamAnswer({ examSessionId: attempt.examSessionId, questionId: attempt.orderedQuestionIds[0], selectedOptionKey: 'a' })

    return (await store.finalizeExamAttempt(attempt.examSessionId, 3000)).attempt
  }

  function rawWrite(record) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName)

      request.onsuccess = () => {
        const database = request.result
        const transaction = database.transaction('examAttempts', 'readwrite')

        transaction.objectStore('examAttempts').put(record)
        transaction.oncomplete = () => (database.close(), resolve())
        transaction.onerror = () => reject(transaction.error)
      }
      request.onerror = () => reject(request.error)
    })
  }

  it('the unconditional legacy method no longer exists; discardActiveExamAttempt is the only delete path', async () => {
    const store = await readyStore()

    expect(store.discardExamAttempt).toBeUndefined()
    expect(Object.keys(store).filter((name) => /discard|delete|remove|clear|purge|reset|drop/i.test(name))).toEqual(['discardActiveExamAttempt'])
  })

  it('direct reproduction of the review finding: a submitted record with sentinel result survives every delete-like method', async () => {
    const store = await readyStore()
    const sentinel = { examSessionId: 'completed-1', status: 'submitted', result: { sentinel: true }, completedAt: 123, questionSnapshots: { q: { marker: 'snapshot' } } }

    await rawWrite(sentinel)

    for (const name of Object.keys(store).filter((key) => /discard|delete|remove|clear|purge|reset|drop/i.test(key))) {
      const outcome = await store[name]('completed-1')

      expect(outcome, name).toMatchObject({ discarded: false })
      expect(await store.getExamAttempt('completed-1'), name).toEqual(sentinel)
    }
  })

  it('a real completed attempt keeps result, snapshot and record after any delete attempt, from any connection', async () => {
    const store = await readyStore()
    const other = createProgressStore({ dbName })

    openStores.push(other)
    await other.initialize()

    const done = await completed(store)

    expect(await store.discardActiveExamAttempt(done.examSessionId)).toEqual({ discarded: false, reason: 'notActive' })
    expect(await other.discardActiveExamAttempt(done.examSessionId)).toEqual({ discarded: false, reason: 'notActive' })

    const stored = await store.getExamAttempt(done.examSessionId)

    expect(stored).toEqual(done)
    expect(stored.result).toEqual(done.result)
    expect(stored.questionSnapshots).toEqual(done.questionSnapshots)
    expect(await store.listExamAttempts()).toHaveLength(1)
  })

  it('running attempts (valid or damaged) are still discardable and other completed attempts are untouched', async () => {
    const store = await readyStore()
    const done = await completed(store, 5)
    const { attempt: running } = await startExam(store, { count: 12, random: seededRandom(6), now: 4000 })

    await rawWrite({ ...running, currentIndex: 999 }) // beschädigt, aber laufend

    expect(await store.discardActiveExamAttempt(running.examSessionId)).toEqual({ discarded: true })
    expect(await store.getActiveExamAttempt()).toBeNull()
    expect(await store.listExamAttempts()).toEqual([done])
  })

  it('submit vs discard over two connections: never a vanished result, ghost record or half state (both start orders)', async () => {
    for (let round = 0; round < 8; round++) {
      dbName = `exam-review-db-${Math.random().toString(36).slice(2)}`

      const tabA = await readyStore()
      const tabB = createProgressStore({ dbName })

      openStores.push(tabB)
      await tabB.initialize()

      const { attempt } = await startExam(tabA, { count: 12, random: seededRandom(round + 1), now: 1000 })
      const id = attempt.examSessionId
      const submit = () => tabA.finalizeExamAttempt(id, 5000)
      const discard = () => tabB.discardActiveExamAttempt(id)
      let finalized
      let discarded

      if (round % 2) {
        const pendingDiscard = discard()
        const pendingSubmit = submit()

        ;[discarded, finalized] = await Promise.all([pendingDiscard, pendingSubmit])
      } else {
        const pendingSubmit = submit()
        const pendingDiscard = discard()

        ;[finalized, discarded] = await Promise.all([pendingSubmit, pendingDiscard])
      }

      const all = await tabA.listExamAttempts()

      if (discarded.discarded) {
        expect(all).toEqual([]) // aktiv verworfen, bevor die Abgabe lief: kein Ghost-Record
        expect(finalized).toMatchObject({ finalized: false, reason: 'notFound' })
      } else {
        expect(discarded).toEqual({ discarded: false, reason: 'notActive' })
        expect(all).toHaveLength(1)
        expect(all[0]).toMatchObject({ status: EXAM_STATUS.SUBMITTED })
        expect(all[0]).toEqual(finalized.attempt) // Result und Snapshot vollständig vorhanden
        expect(validateExamAttempt(all[0]).valid).toBe(true)
      }
    }
  })

  it('a damaged running attempt vs concurrent submit and discard ends deleted or untouched, never submitted', async () => {
    const store = await readyStore()
    const { attempt } = await startExam(store, { count: 12, random: seededRandom(9), now: 1000 })
    const damaged = { ...attempt, currentIndex: 999 }

    await rawWrite(damaged)

    const [finalized, discarded] = await Promise.all([store.finalizeExamAttempt(attempt.examSessionId, 5000), store.discardActiveExamAttempt(attempt.examSessionId)])
    const stored = await store.getExamAttempt(attempt.examSessionId)

    expect(finalized.finalized).toBe(false) // ein beschädigter Versuch wird nie abgegeben
    expect(discarded).toEqual({ discarded: true })
    expect(stored).toBeNull()
  })
})

// --- P3D-RT-002: memoryAid.type -----------------------------------------------------------------------------------

describe('memoryAid.type in exam snapshots (P3D-RT-002)', () => {
  const withAid = (attempt, aid) => {
    const copy = clone(attempt)
    const id = copy.orderedQuestionIds[2]

    if (aid === undefined) {
      delete copy.questionSnapshots[id].content.memoryAid
    } else {
      copy.questionSnapshots[id].content.memoryAid = aid
    }

    return copy
  }

  for (const language of ['de', 'en']) {
    describe(`language ${language}`, () => {
      it('a valid memory aid (closed enum type) is valid, in a running and in a submitted attempt, and the type is passed through', async () => {
        const { make } = await pooled()
        const running = make({ language })
        const done = submitted(running)

        expect(validateExamAttempt(running)).toEqual({ valid: true, problems: [] })
        expect(validateExamAttempt(done).valid).toBe(true)

        const aid = buildExamReview(done).review.items[2].memoryAid

        expect(aid.type).toBe('mini_scenario')
        expect(aid.text).toBeTruthy()
      })

      it('a present memory aid without type is invalid (no review with half-valid data)', async () => {
        const { make } = await pooled()
        const done = submitted(make({ language }))
        const [text] = [done.questionSnapshots[done.orderedQuestionIds[2]].content.memoryAid.text]
        const broken = withAid(done, { text })

        expect(validateExamAttempt(broken)).toMatchObject({ valid: false, problems: expect.arrayContaining(['snapshotContent']) })
        expect(buildExamReview(broken)).toEqual({ ok: false, reason: REVIEW_PROBLEM.INVALID })
      })

      it('unknown, empty or non-string types and a non-object memory aid are invalid', async () => {
        const { make } = await pooled()
        const done = submitted(make({ language }))
        const text = 'Merkhilfe'

        for (const aid of [{ type: 'future_type', text }, { type: '', text }, { type: null, text }, { type: 7, text }, { type: ['mnemonic'], text }, 'mnemonic', ['mnemonic'], { type: 'mnemonic' }, { type: 'mnemonic', text: '' }]) {
          expect(validateExamAttempt(withAid(done, aid)).valid, JSON.stringify(aid)).toBe(false)
          expect(buildExamReview(withAid(done, aid)).ok, JSON.stringify(aid)).toBe(false)
        }
      })

      it('every closed enum type is accepted', async () => {
        const { make } = await pooled()
        const done = submitted(make({ language }))

        for (const type of ['mnemonic', 'confusion', 'exam_trap', 'practice_anchor', 'contrast', 'mini_scenario', 'rule_of_thumb']) {
          expect(validateExamAttempt(withAid(done, { type, text: 'ok' })).valid, type).toBe(true)
        }
      })

      it('a missing memory aid stays valid (not over-validated) and yields no memory aid in the review', async () => {
        const { make } = await pooled()
        const done = submitted(make({ language }))

        for (const aid of [undefined, null]) {
          const attempt = withAid(done, aid)

          expect(validateExamAttempt(attempt).valid).toBe(true)
          expect(buildExamReview(attempt).review.items[2].memoryAid).toBeNull()
        }
      })
    })
  }

  it('the same check protects a running attempt: it is reported as invalid instead of continuing with a damaged snapshot', async () => {
    const { make } = await pooled()
    const running = make()
    const broken = withAid(running, { text: 'ohne Typ' })

    expect(validateExamAttempt(broken).valid).toBe(false)
  })
})
