import { describe, expect, it } from 'vitest'
import {
  EXAM_SCHEMA_VERSION,
  EXAM_STATUS,
  applyExamAnswer,
  createExamAttempt,
  finalizeExamAttemptRecord,
  moveExamPosition,
  presentExamQuestion,
  scoreExamAttempt,
  setExamPosition,
  summarizeExamAttempt,
  validateExamAttempt,
} from '../src/domain/examAttempt.js'
import { EXAM_ERROR } from '../src/domain/examSelection.js'
import { isValidOptionOrder } from '../src/domain/session.js'
import { parseV2Library } from '../src/lib/library/parseLibrary.js'
import { clone, deepFreeze, makeExamLibraryData, seededRandom } from './fixtures/examFixtures.js'

const SIZES = { la01: 60, la02: 90, la03: 40, la04: 30 }

function buildPool(sizes = SIZES, options = {}) {
  const parsed = makeExamLibraryData(sizes, options).map(parseV2Library)

  return {
    libraries: parsed.map(({ library }) => library),
    pool: parsed.flatMap(({ library, questions }) =>
      questions.map((question) => ({ question, libraryId: library.libraryId, sectionId: library.learningSectionId })),
    ),
  }
}

function makeAttempt({ count = 20, language = 'de', seed = 1, sizes = SIZES, options = {}, now = 1000 } = {}) {
  const { pool, libraries } = buildPool(sizes, options)

  return { pool, libraries, attempt: createExamAttempt({ pool, libraries, language, count, random: seededRandom(seed), now, examSessionId: 'exam-1' }) }
}

// Antwort, die laut Snapshot richtig ist bzw. sicher falsch.
const correctKey = (attempt, id) => attempt.questionSnapshots[id].correctOptionKey
const wrongKey = (attempt, id) => ['a', 'b', 'c', 'd'].find((key) => key !== correctKey(attempt, id))

function answerAll(attempt, choose) {
  return attempt.orderedQuestionIds.reduce(
    (current, id) => applyExamAnswer(current, { questionId: id, selectedOptionKey: choose(current, id), now: 2000 }).attempt,
    attempt,
  )
}

describe('createExamAttempt', () => {
  it.each([
    ['short', 20],
    ['medium', 45],
    ['long', 90],
  ])('creates a %s exam with %i unique questions', (preset, count) => {
    const { pool, libraries } = buildPool()
    const attempt = createExamAttempt({ pool, libraries, preset, random: seededRandom(4), now: 5 })

    expect(attempt.questionCount).toBe(count)
    expect(attempt.orderedQuestionIds).toHaveLength(count)
    expect(new Set(attempt.orderedQuestionIds).size).toBe(count)
    expect(attempt.examPreset).toBe(preset)
    expect(validateExamAttempt(attempt)).toEqual({ valid: true, problems: [] })
  })

  it('uses 45 questions when nothing is requested and accepts an explicit count', () => {
    const { pool, libraries } = buildPool()

    expect(createExamAttempt({ pool, libraries }).questionCount).toBe(45)
    expect(createExamAttempt({ pool, libraries, count: 12 })).toMatchObject({ questionCount: 12, examPreset: 'custom' })
  })

  it('writes the documented record fields and nothing from the learning-round model', () => {
    const { attempt } = makeAttempt()

    expect(attempt).toMatchObject({
      examSessionId: 'exam-1',
      examSchemaVersion: EXAM_SCHEMA_VERSION,
      sessionMode: 'exam',
      status: EXAM_STATUS.IN_PROGRESS,
      sessionStartedAt: 1000,
      lastActivityAt: 1000,
      completedAt: null,
      timerMode: 'none',
      currentIndex: 0,
      currentQuestionId: attempt.orderedQuestionIds[0],
      answers: {},
      result: null,
      poolSize: 220,
      skippedForLanguage: 0,
    })
    ;[
      'sectionId',
      'answeredQuestionIds',
      'correctQuestionIds',
      'sessionCorrectCount',
      'sessionIncorrectCount',
      'currentStreak',
      'bestSessionStreak',
      'currentQuestionState',
      'libraryId',
    ].forEach((field) => expect(attempt).not.toHaveProperty(field))
  })

  it('selects stratified by learning section', () => {
    const { attempt } = makeAttempt({ count: 45 })
    const perSection = {}

    attempt.orderedQuestionIds.forEach((id) => {
      const sectionId = attempt.questionSnapshots[id].sectionId

      perSection[sectionId] = (perSection[sectionId] ?? 0) + 1
    })

    // 45 · [60, 90, 40, 30] / 220 = 12.27, 18.41, 8.18, 6.14 -> 12 / 18 / 8 / 6 + 1 Rest-Platz (größter Rest: la02)
    expect(perSection).toEqual({ la01: 12, la02: 19, la03: 8, la04: 6 })
  })

  it('stores a German snapshot with everything needed for exam and review', () => {
    const { attempt, pool } = makeAttempt({ language: 'de' })
    const id = attempt.orderedQuestionIds[0]
    const source = pool.find((entry) => entry.question.id === id)
    const snapshot = attempt.questionSnapshots[id]

    expect(attempt.sessionLanguage).toBe('de')
    expect(attempt.languageMode).toBeNull()
    expect(snapshot).toMatchObject({
      sectionId: source.sectionId,
      category: source.question.category,
      difficulty: 'medium',
      correctOptionKey: source.question.correctOptionKey,
      content: {
        question: source.question.localized.de.question,
        optionText: source.question.localized.de.optionText,
        explanation: source.question.localized.de.explanation,
        memoryAid: { type: 'mini_scenario', text: 'Synthetisch.' },
      },
    })
    expect(snapshot.content.question).toContain('Frage')
    expect(attempt.questionLibraries[id]).toBe(source.libraryId)
    expect(attempt.questionRevisions[id]).toBe(source.question.contentRevision)
    expect(attempt.libraries.map((entry) => entry.libraryId)).toEqual(['exam-lib-la01', 'exam-lib-la02', 'exam-lib-la03', 'exam-lib-la04'])
    expect(attempt.libraries[0]).toEqual({
      libraryId: 'exam-lib-la01',
      libraryVersion: '1.0.0',
      activeQuestionIndexHash: expect.stringMatching(/^sha256:/),
    })
  })

  it('stores an English snapshot with English text only, fixed language and onlyEnglish mode', () => {
    const { attempt, pool } = makeAttempt({ language: 'en' })

    expect(attempt.sessionLanguage).toBe('en')
    expect(attempt.languageMode).toBe('onlyEnglish')

    attempt.orderedQuestionIds.forEach((id) => {
      const english = pool.find((entry) => entry.question.id === id).question.localized.en
      const { content } = attempt.questionSnapshots[id]

      expect(content).toEqual({ question: english.question, optionText: english.optionText, explanation: english.explanation, memoryAid: english.memoryAid })
      expect(JSON.stringify(content)).not.toContain('Synthetisch')
    })
  })

  it('English uses only questions with valid English and records the skipped ones', () => {
    const english = Array.from({ length: 15 }, (_, index) => `sec-a01-${String(index + 1).padStart(4, '0')}`)
    const { pool, libraries } = buildPool({ la01: 30, la02: 30 }, { english })
    // Englisch haben nur die ersten 15 Fragen von la01; alle anderen Fragen (la01 ab 0016 und ganz la02) haben keins.
    const attempt = createExamAttempt({ pool, libraries, language: 'en', count: 10, random: seededRandom(2) })

    expect(attempt.poolSize).toBe(60)
    expect(attempt.skippedForLanguage).toBe(45)
    expect(attempt.orderedQuestionIds.every((id) => english.includes(id))).toBe(true)
    expect(() => createExamAttempt({ pool, libraries, language: 'en', count: 16 })).toThrow(expect.objectContaining({ code: EXAM_ERROR.POOL_TOO_SMALL }))
    expect(createExamAttempt({ pool, libraries, language: 'de', count: 16 }).questionCount).toBe(16)
  })

  // P3B-RT-002: N = min(preset, Pool), Mindestpool 10, explizite Anzahl nie still gekappt.
  describe('preset capping', () => {
    const sizesFor = (total) => {
      const first = Math.ceil(total / 2)

      return { la01: first, la02: total - first }
    }

    it.each([
      [10, { short: 10, medium: 10, long: 10 }],
      [19, { short: 19, medium: 19, long: 19 }],
      [20, { short: 20, medium: 20, long: 20 }],
      [40, { short: 20, medium: 40, long: 40 }],
      [44, { short: 20, medium: 44, long: 44 }],
      [45, { short: 20, medium: 45, long: 45 }],
      [89, { short: 20, medium: 45, long: 89 }],
      [90, { short: 20, medium: 45, long: 90 }],
      [220, { short: 20, medium: 45, long: 90 }],
    ])('pool of %i questions', (poolSize, expected) => {
      const { pool, libraries } = buildPool(sizesFor(poolSize))

      Object.entries(expected).forEach(([preset, count]) => {
        const attempt = createExamAttempt({ pool, libraries, preset, random: seededRandom(poolSize) })

        expect(attempt.examPreset).toBe(preset)
        expect(attempt.questionCount).toBe(count)
        expect(new Set(attempt.orderedQuestionIds).size).toBe(count)
        expect(validateExamAttempt(attempt)).toEqual({ valid: true, problems: [] })
      })

      expect(createExamAttempt({ pool, libraries }).questionCount).toBe(expected.medium)
    })

    it('still refuses a pool below the minimum, for every preset and the default', () => {
      const { pool, libraries } = buildPool(sizesFor(9))

      for (const preset of ['short', 'medium', 'long', null]) {
        expect(() => createExamAttempt({ pool, libraries, preset })).toThrow(expect.objectContaining({ code: EXAM_ERROR.POOL_TOO_SMALL }))
      }
    })

    it('caps on the language-eligible pool, not on the whole pool', () => {
      const english = Array.from({ length: 15 }, (_, index) => `sec-a01-${String(index + 1).padStart(4, '0')}`)
      const { pool, libraries } = buildPool({ la01: 30, la02: 30 }, { english })
      const attempt = createExamAttempt({ pool, libraries, language: 'en', preset: 'long', random: seededRandom(1) })

      expect(attempt).toMatchObject({ examPreset: 'long', questionCount: 15, poolSize: 60, skippedForLanguage: 45 })
      expect(validateExamAttempt(attempt).valid).toBe(true)
    })

    it('does not cap an explicit count: it must fit the pool', () => {
      const { pool, libraries } = buildPool(sizesFor(40))

      expect(createExamAttempt({ pool, libraries, count: 40 }).questionCount).toBe(40)
      expect(() => createExamAttempt({ pool, libraries, count: 41 })).toThrow(expect.objectContaining({ code: EXAM_ERROR.POOL_TOO_SMALL }))
    })
  })

  it('rejects an unsupported language (no allAvailable / fallback mixing) and a too small pool', () => {
    const { pool, libraries } = buildPool()

    expect(() => createExamAttempt({ pool, libraries, language: 'fr' })).toThrow(expect.objectContaining({ code: EXAM_ERROR.INVALID_LANGUAGE }))
    expect(() => createExamAttempt({ pool, libraries, count: 221 })).toThrow(expect.objectContaining({ code: EXAM_ERROR.POOL_TOO_SMALL }))
    expect(() => createExamAttempt({ pool: pool.slice(0, 9), libraries, count: 5 })).toThrow(expect.objectContaining({ code: EXAM_ERROR.POOL_TOO_SMALL }))
  })

  it('draws a valid option permutation for every question, fixed at creation', () => {
    const { attempt } = makeAttempt({ count: 45 })

    expect(Object.keys(attempt.optionOrder).sort()).toEqual([...attempt.orderedQuestionIds].sort())
    Object.values(attempt.optionOrder).forEach((order) => expect(isValidOptionOrder(order)).toBe(true))
    expect(Object.values(attempt.optionOrder).some((order) => order.join('') !== 'abcd')).toBe(true)
  })

  it('is reproducible with an injected RNG and random without one', () => {
    const first = makeAttempt({ seed: 9 }).attempt
    const second = makeAttempt({ seed: 9 }).attempt
    const other = makeAttempt({ seed: 10 }).attempt

    expect(second).toEqual(first)
    expect(other.orderedQuestionIds).not.toEqual(first.orderedQuestionIds)

    const { pool, libraries } = buildPool()
    const orders = new Set(Array.from({ length: 5 }, () => createExamAttempt({ pool, libraries, count: 20 }).orderedQuestionIds.join()))

    expect(orders.size).toBeGreaterThan(1)
  })

  it('gives every attempt its own id', () => {
    const { pool, libraries } = buildPool()
    const ids = new Set(Array.from({ length: 20 }, () => createExamAttempt({ pool, libraries, count: 10 }).examSessionId))

    expect(ids.size).toBe(20)
  })

  it('copies the question data: later changes to the library objects do not reach the attempt', () => {
    const { pool, libraries } = buildPool()
    const attempt = createExamAttempt({ pool, libraries, count: 20, random: seededRandom(1) })
    const before = clone(attempt)

    pool.forEach((entry) => {
      entry.question.localized.de.question = 'GEÄNDERT'
      entry.question.localized.de.optionText.a = 'GEÄNDERT'
      entry.question.localized.de.explanation = 'GEÄNDERT'
      entry.question.localized.de.memoryAid.text = 'GEÄNDERT'
      entry.question.correctOptionKey = 'd'
      entry.question.contentRevision = 99
    })
    libraries.forEach((library) => {
      library.libraryVersion = '9.9.9'
    })

    expect(attempt).toEqual(before)
  })
})

describe('applyExamAnswer', () => {
  it('stores an answer, replaces it later and makes the question current', () => {
    const { attempt } = makeAttempt()
    const [, second] = attempt.orderedQuestionIds
    const first = applyExamAnswer(attempt, { questionId: second, selectedOptionKey: 'c', now: 1500 })

    expect(first.applied).toBe(true)
    expect(first.attempt).toMatchObject({ answers: { [second]: 'c' }, currentIndex: 1, currentQuestionId: second, lastActivityAt: 1500 })

    const changed = applyExamAnswer(first.attempt, { questionId: second, selectedOptionKey: 'b', now: 1600 })

    expect(changed.attempt.answers).toEqual({ [second]: 'b' })
    expect(changed.attempt.lastActivityAt).toBe(1600)
  })

  it('rejects an invalid option key and an unknown question without changing anything', () => {
    const { attempt } = makeAttempt()
    const id = attempt.orderedQuestionIds[0]

    for (const selectedOptionKey of ['e', 'A', '', null, undefined, 1]) {
      expect(applyExamAnswer(attempt, { questionId: id, selectedOptionKey })).toEqual({ applied: false, reason: 'invalidOption', attempt })
    }

    expect(applyExamAnswer(attempt, { questionId: 'sec-a99-9999', selectedOptionKey: 'a' })).toMatchObject({ applied: false, reason: 'unknownQuestion' })
  })

  it('does not change the order, the snapshots or the option order', () => {
    const { attempt } = makeAttempt()
    const answered = answerAll(attempt, (current, id) => correctKey(current, id))

    expect(answered.orderedQuestionIds).toEqual(attempt.orderedQuestionIds)
    expect(answered.optionOrder).toEqual(attempt.optionOrder)
    expect(answered.questionSnapshots).toEqual(attempt.questionSnapshots)
  })

  it('never mutates its input (deep-frozen attempt)', () => {
    const { attempt } = makeAttempt()
    const frozen = deepFreeze(clone(attempt))
    const id = frozen.orderedQuestionIds[3]

    expect(() => applyExamAnswer(frozen, { questionId: id, selectedOptionKey: 'a', now: 3 })).not.toThrow()
    expect(() => setExamPosition(frozen, { index: 4, now: 3 })).not.toThrow()
    expect(() => finalizeExamAttemptRecord(frozen, 9)).not.toThrow()
  })

  it('refuses every change on a submitted attempt', () => {
    const { attempt } = makeAttempt()
    const submitted = finalizeExamAttemptRecord(answerAll(attempt, (current, id) => correctKey(current, id)), 3000).attempt
    const id = submitted.orderedQuestionIds[0]

    expect(applyExamAnswer(submitted, { questionId: id, selectedOptionKey: wrongKey(submitted, id) })).toEqual({ applied: false, reason: 'submitted', attempt: submitted })
    expect(setExamPosition(submitted, { index: 3 })).toMatchObject({ applied: false, reason: 'submitted' })
    expect(moveExamPosition(submitted, 'next')).toMatchObject({ applied: false, reason: 'submitted' })
  })

  it('refuses to touch a damaged attempt', () => {
    const { attempt } = makeAttempt()
    const damaged = { ...attempt, currentIndex: 99 }

    expect(applyExamAnswer(damaged, { questionId: attempt.orderedQuestionIds[0], selectedOptionKey: 'a' })).toMatchObject({ applied: false, reason: 'invalid' })
    expect(finalizeExamAttemptRecord(damaged, 5)).toMatchObject({ finalized: false, reason: 'invalid' })
  })
})

describe('navigation', () => {
  it('moves next / previous / direct and stays inside 0 <= index < questionCount', () => {
    const { attempt } = makeAttempt({ count: 20 })
    const ids = attempt.orderedQuestionIds
    const next = moveExamPosition(attempt, 'next', { now: 1100 })

    expect(next.attempt).toMatchObject({ currentIndex: 1, currentQuestionId: ids[1], lastActivityAt: 1100 })
    expect(moveExamPosition(next.attempt, 'previous').attempt).toMatchObject({ currentIndex: 0, currentQuestionId: ids[0] })
    expect(setExamPosition(attempt, { index: 19 }).attempt).toMatchObject({ currentIndex: 19, currentQuestionId: ids[19] })
    expect(setExamPosition(attempt, { questionId: ids[7] }).attempt.currentIndex).toBe(7)

    expect(moveExamPosition(attempt, 'previous')).toMatchObject({ applied: false, reason: 'outOfRange' })
    expect(moveExamPosition(setExamPosition(attempt, { index: 19 }).attempt, 'next')).toMatchObject({ applied: false, reason: 'outOfRange' })
    expect(setExamPosition(attempt, { index: 20 })).toMatchObject({ applied: false, reason: 'outOfRange' })
    expect(setExamPosition(attempt, { index: -1 })).toMatchObject({ applied: false, reason: 'outOfRange' })
    expect(setExamPosition(attempt, { index: 1.5 })).toMatchObject({ applied: false, reason: 'outOfRange' })
    expect(setExamPosition(attempt, { questionId: 'nope' })).toMatchObject({ applied: false, reason: 'unknownQuestion' })
    expect(moveExamPosition(attempt, 'sideways')).toMatchObject({ applied: false, reason: 'invalidDirection' })
  })

  it('navigation never touches answers or orders', () => {
    const { attempt } = makeAttempt()
    const answered = applyExamAnswer(attempt, { questionId: attempt.orderedQuestionIds[2], selectedOptionKey: 'b' }).attempt
    const moved = setExamPosition(answered, { index: 9 }).attempt

    expect(moved.answers).toEqual(answered.answers)
    expect(moved.orderedQuestionIds).toEqual(answered.orderedQuestionIds)
    expect(moved.optionOrder).toEqual(answered.optionOrder)
  })
})

describe('summarizeExamAttempt', () => {
  it('counts answered and unanswered questions at any time, also after an answer change', () => {
    const { attempt } = makeAttempt({ count: 20 })
    const [a, b] = attempt.orderedQuestionIds

    expect(summarizeExamAttempt(attempt)).toEqual({ questionCount: 20, answeredCount: 0, unansweredCount: 20 })

    let current = applyExamAnswer(attempt, { questionId: a, selectedOptionKey: 'a' }).attempt
    current = applyExamAnswer(current, { questionId: b, selectedOptionKey: 'b' }).attempt
    current = applyExamAnswer(current, { questionId: b, selectedOptionKey: 'c' }).attempt

    expect(summarizeExamAttempt(current)).toEqual({ questionCount: 20, answeredCount: 2, unansweredCount: 18 })
  })
})

describe('scoring and finalization', () => {
  it('all correct = 100 %, evaluated by option key, independent of the display position', () => {
    const { attempt } = makeAttempt({ count: 20 })
    const submitted = finalizeExamAttemptRecord(answerAll(attempt, (current, id) => correctKey(current, id)), 4000)

    expect(submitted.finalized).toBe(true)
    expect(submitted.attempt.result).toMatchObject({ total: 20, correct: 20, incorrect: 0, unanswered: 0, percent: 100, finalizedAt: 4000 })
    // Die richtige Option steht in vielen Fragen nicht an Position a: die Position darf keine Rolle spielen.
    expect(attempt.orderedQuestionIds.filter((id) => attempt.optionOrder[id][0] !== correctKey(attempt, id)).length).toBeGreaterThan(0)
  })

  it('all wrong = 0 %, nothing answered = 0 % with everything unanswered', () => {
    const { attempt } = makeAttempt({ count: 20 })
    const wrong = finalizeExamAttemptRecord(answerAll(attempt, (current, id) => wrongKey(current, id)), 1).attempt.result
    const empty = finalizeExamAttemptRecord(attempt, 1).attempt.result

    expect(wrong).toMatchObject({ correct: 0, incorrect: 20, unanswered: 0, percent: 0 })
    expect(empty).toMatchObject({ correct: 0, incorrect: 0, unanswered: 20, percent: 0 })
  })

  it('counts a mix correctly; percent = correct / total (not / answered), rounded', () => {
    const { attempt } = makeAttempt({ count: 45 })
    const ids = attempt.orderedQuestionIds
    let current = attempt

    ids.slice(0, 20).forEach((id) => {
      current = applyExamAnswer(current, { questionId: id, selectedOptionKey: correctKey(current, id) }).attempt
    })
    ids.slice(20, 30).forEach((id) => {
      current = applyExamAnswer(current, { questionId: id, selectedOptionKey: wrongKey(current, id) }).attempt
    })

    expect(summarizeExamAttempt(current)).toEqual({ questionCount: 45, answeredCount: 30, unansweredCount: 15 })

    const { result } = finalizeExamAttemptRecord(current, 7).attempt

    expect(result).toMatchObject({ total: 45, correct: 20, incorrect: 10, unanswered: 15, percent: 44 }) // 44.44 -> 44
    expect(result.correct + result.incorrect + result.unanswered).toBe(result.total)
  })

  it('rounds the percentage half up', () => {
    const { attempt } = makeAttempt({ count: 40 })
    const ids = attempt.orderedQuestionIds
    const answered = ids.slice(0, 1).reduce((current, id) => applyExamAnswer(current, { questionId: id, selectedOptionKey: correctKey(current, id) }).attempt, attempt)

    expect(scoreExamAttempt(answered, 1).percent).toBe(3) // 2.5 -> 3
  })

  it('breaks the result down by learning section and the sums add up', () => {
    const { attempt } = makeAttempt({ count: 45 })
    const answered = answerAll(attempt, (current, id) => (current.questionSnapshots[id].sectionId === 'la01' ? correctKey(current, id) : wrongKey(current, id)))
    const { result } = finalizeExamAttemptRecord(answered, 5).attempt

    expect(result.perSection.map((section) => section.sectionId)).toEqual(['la01', 'la02', 'la03', 'la04'])
    expect(result.perSection.reduce((sum, section) => sum + section.total, 0)).toBe(45)
    expect(result.perSection.find((section) => section.sectionId === 'la01')).toMatchObject({ total: 12, correct: 12, incorrect: 0, unanswered: 0 })
    expect(result.perSection.find((section) => section.sectionId === 'la02')).toMatchObject({ total: 19, correct: 0, incorrect: 19 })
    expect(result.correct).toBe(12)
  })

  it('scores against the snapshot, not against any live data', () => {
    const { attempt, pool } = makeAttempt({ count: 20 })
    const answered = answerAll(attempt, (current, id) => correctKey(current, id))

    pool.forEach((entry) => {
      entry.question.correctOptionKey = entry.question.correctOptionKey === 'a' ? 'b' : 'a'
    })

    expect(finalizeExamAttemptRecord(answered, 1).attempt.result.percent).toBe(100)
  })

  it('sets the completed state exactly once; a second finalize returns the identical record', () => {
    const { attempt } = makeAttempt({ count: 20 })
    const first = finalizeExamAttemptRecord(answerAll(attempt, (current, id) => correctKey(current, id)), 5000)

    expect(first.attempt).toMatchObject({ status: 'submitted', completedAt: 5000, lastActivityAt: 5000 })
    expect(validateExamAttempt(first.attempt).valid).toBe(true)

    const second = finalizeExamAttemptRecord(first.attempt, 9999)

    expect(second).toEqual({ finalized: false, reason: 'alreadySubmitted', attempt: first.attempt })
    expect(second.attempt).toBe(first.attempt)
    expect(second.attempt.completedAt).toBe(5000)
    expect(second.attempt.result.finalizedAt).toBe(5000)
  })
})

describe('presentExamQuestion (active view model)', () => {
  it('exposes only text, options in the stored order, selection and navigation metadata', () => {
    const { attempt } = makeAttempt({ count: 20 })
    const id = attempt.orderedQuestionIds[4]
    const answered = applyExamAnswer(attempt, { questionId: id, selectedOptionKey: 'c' }).attempt
    const view = presentExamQuestion(answered, id)

    expect(Object.keys(view).sort()).toEqual(['id', 'index', 'options', 'selectedKey', 'text', 'total'])
    expect(view).toMatchObject({ id, index: 4, total: 20, selectedKey: 'c', text: attempt.questionSnapshots[id].content.question })
    expect(view.options.map((option) => option.key)).toEqual(attempt.optionOrder[id])
    view.options.forEach((option) => {
      expect(Object.keys(option).sort()).toEqual(['key', 'text'])
      expect(option.text).toBe(attempt.questionSnapshots[id].content.optionText[option.key])
    })
    expect(presentExamQuestion(attempt, id).selectedKey).toBeNull()
    expect(presentExamQuestion(attempt, 'unknown')).toBeNull()
  })

  it('leaks neither the solution, the explanation nor the memory aid, for any question and language', () => {
    for (const language of ['de', 'en']) {
      const { attempt } = makeAttempt({ count: 20, language })

      attempt.orderedQuestionIds.forEach((id) => {
        const view = presentExamQuestion(attempt, id)
        const serialized = JSON.stringify(view)
        const { content } = attempt.questionSnapshots[id]

        expect(serialized).not.toContain('correctOptionKey')
        expect(serialized).not.toContain('correctAnswer')
        expect(serialized).not.toContain('explanation')
        expect(serialized).not.toContain('memoryAid')
        expect(serialized).not.toContain(content.explanation)
        expect(serialized).not.toContain(content.memoryAid.text)
        expect(view).not.toHaveProperty('correctOptionKey')
      })
    }
  })
})

describe('validateExamAttempt', () => {
  const tamper = (change) => {
    const { attempt } = makeAttempt()
    const copy = clone(attempt)

    change(copy)

    return validateExamAttempt(copy)
  }

  it('flags every broken invariant', () => {
    expect(tamper((a) => a.orderedQuestionIds.push(a.orderedQuestionIds[0])).problems).toContain('duplicateQuestionIds')
    expect(tamper((a) => { a.questionCount = 5 }).problems).toContain('questionCount')
    expect(tamper((a) => { a.currentIndex = 20 }).problems).toContain('currentIndex')
    expect(tamper((a) => { a.currentQuestionId = a.orderedQuestionIds[3] }).problems).toContain('currentQuestionId')
    expect(tamper((a) => { a.answers = { 'sec-a99-0001': 'a' } }).problems).toContain('answers')
    expect(tamper((a) => { a.answers = { [a.orderedQuestionIds[0]]: 'z' } }).problems).toContain('answers')
    expect(tamper((a) => { a.optionOrder[a.orderedQuestionIds[0]] = ['a', 'a', 'b', 'c'] }).problems).toContain('optionOrder')
    expect(tamper((a) => { delete a.questionSnapshots[a.orderedQuestionIds[0]] }).problems).toContain('questionSnapshots')
    expect(tamper((a) => { a.questionSnapshots[a.orderedQuestionIds[0]].correctOptionKey = 'x' }).problems).toContain('snapshotContent')
    expect(tamper((a) => { a.questionSnapshots[a.orderedQuestionIds[0]].content.optionText.a = '' }).problems).toContain('snapshotContent')
    expect(tamper((a) => { delete a.questionLibraries[a.orderedQuestionIds[0]] }).problems).toContain('questionLibraries')
    expect(tamper((a) => { a.questionRevisions[a.orderedQuestionIds[0]] = 'x' }).problems).toContain('questionRevisions')
    expect(tamper((a) => { a.sessionLanguage = 'fr' }).problems).toContain('sessionLanguage')
    expect(tamper((a) => { a.languageMode = 'allAvailable' }).problems).toContain('languageMode')
    expect(tamper((a) => { a.sessionMode = 'learning' }).problems).toContain('sessionMode')
    expect(tamper((a) => { a.examSchemaVersion = 2 }).problems).toContain('examSchemaVersion')
    expect(validateExamAttempt(null).valid).toBe(false)
    expect(validateExamAttempt({}).valid).toBe(false)
  })

  it('ties status, result and completedAt together', () => {
    expect(tamper((a) => { a.status = 'submitted' }).problems).toEqual(expect.arrayContaining(['resultStatus', 'completedAtStatus']))
    expect(tamper((a) => { a.result = { total: 1 } }).problems).toContain('resultStatus')
    expect(tamper((a) => { a.completedAt = 5 }).problems).toContain('completedAtStatus')
  })
})

// P3B-RT-003: geschlossene Invarianten für Ergebnis und Metadaten (beschädigte / extern geschriebene Datensätze).
describe('validateExamAttempt: closed result and metadata invariants', () => {
  function submittedAttempt() {
    const { attempt } = makeAttempt({ count: 20 })
    const ids = attempt.orderedQuestionIds
    let current = attempt

    ids.slice(0, 12).forEach((id) => {
      current = applyExamAnswer(current, { questionId: id, selectedOptionKey: correctKey(current, id) }).attempt
    })
    ids.slice(12, 15).forEach((id) => {
      current = applyExamAnswer(current, { questionId: id, selectedOptionKey: wrongKey(current, id) }).attempt
    })

    return finalizeExamAttemptRecord(current, 5000).attempt
  }

  const tamperSubmitted = (change) => {
    const copy = clone(submittedAttempt())

    change(copy)

    return validateExamAttempt(copy)
  }

  it('accepts a correctly finalized attempt (also after a structured-clone round trip)', () => {
    expect(validateExamAttempt(submittedAttempt())).toEqual({ valid: true, problems: [] })
    expect(validateExamAttempt(clone(submittedAttempt())).valid).toBe(true)
  })

  it('the review reproduction no longer validates: result {}, completedAt text, timer limit, bogus preset, negative pool, no libraries', () => {
    for (const change of [
      (a) => { a.result = {} },
      (a) => { a.completedAt = 'not-a-time' },
      (a) => { a.timerMode = 'limit' },
      (a) => { a.examPreset = 'bogus' },
      (a) => { a.poolSize = -1 },
      (a) => { a.libraries = [] },
    ]) {
      expect(tamperSubmitted(change).valid).toBe(false)
    }

    const combined = tamperSubmitted((a) => {
      Object.assign(a, { result: {}, completedAt: 'not-a-time', timerMode: 'limit', examPreset: 'bogus', poolSize: -1, libraries: [] })
    })

    expect(combined.problems).toEqual(expect.arrayContaining(['timerMode', 'examPreset', 'poolSize', 'libraries', 'completedAt']))
  })

  it('rejects a result that does not match snapshot and answers (counts, sums, percent, sections, finalizedAt)', () => {
    const rejected = [
      (a) => { a.result.correct += 1 },
      (a) => { a.result.incorrect -= 1 },
      (a) => { a.result.unanswered += 1 },
      (a) => { a.result.total = 21 },
      (a) => { a.result.percent = 99 },
      (a) => { a.result.finalizedAt = a.completedAt + 1 },
      (a) => { a.result.perSection[0].correct += 1 },
      (a) => { a.result.perSection.pop() },
      (a) => { a.result.perSection[0].sectionId = 'la77' },
      (a) => { a.result.extra = true },
      (a) => { delete a.result.percent },
      (a) => { a.result = [a.result] },
    ]

    rejected.forEach((change) => expect(tamperSubmitted(change).problems).toContain('result'))
  })

  it('rejects an answer changed after submit (result no longer matches) and a non-finite or early completedAt', () => {
    expect(tamperSubmitted((a) => { a.answers[a.orderedQuestionIds[0]] = wrongKey(a, a.orderedQuestionIds[0]) }).problems).toContain('result')
    expect(tamperSubmitted((a) => { a.completedAt = NaN }).problems).toContain('completedAt')
    expect(tamperSubmitted((a) => { a.completedAt = a.sessionStartedAt - 1; a.result.finalizedAt = a.completedAt }).problems).toContain('completedAt')
  })

  it('checks preset and pool values against each other', () => {
    const preset = clone(createExamAttempt({ ...buildPool({ la01: 30, la02: 30 }), preset: 'medium', random: seededRandom(1) }))

    expect(validateExamAttempt(preset).valid).toBe(true)

    const relabelled = clone(preset)

    relabelled.examPreset = 'short' // 45 Fragen passen nicht zu min(20, 60)
    expect(validateExamAttempt(relabelled).problems).toEqual(['presetQuestionCount'])

    for (const change of [
      (a) => { a.questionCount = 44; a.orderedQuestionIds.pop() }, // Preset medium, Pool 60: muss 45 sein
      (a) => { a.poolSize = 40 }, // weniger Pool als nötig -> questionCount passt nicht mehr zu min(45, 40)
      (a) => { a.skippedForLanguage = 1 }, // Deutsch überspringt nie
      (a) => { a.skippedForLanguage = 1.5 },
      (a) => { a.poolSize = 44 },
    ]) {
      const copy = clone(preset)

      change(copy)
      expect(validateExamAttempt(copy).valid).toBe(false)
    }
  })

  it('requires every used library to be listed with version and hash', () => {
    expect(tamperSubmitted((a) => { a.libraries.pop() }).problems).toContain('libraries')
    expect(tamperSubmitted((a) => { a.libraries[0].libraryVersion = '' }).problems).toContain('libraries')
    expect(tamperSubmitted((a) => { delete a.libraries[0].activeQuestionIndexHash }).problems).toContain('libraries')
    expect(tamperSubmitted((a) => { a.libraries = 'none' }).problems).toContain('libraries')
  })

  it('a stepping-back system clock cannot turn a legitimate submit into a damaged record', () => {
    const { attempt } = makeAttempt({ count: 20, now: 10_000 })
    const done = finalizeExamAttemptRecord(attempt, 2_000)

    expect(done.finalized).toBe(true)
    expect(done.attempt.completedAt).toBe(10_000)
    expect(done.attempt.result.finalizedAt).toBe(10_000)
    expect(validateExamAttempt(done.attempt).valid).toBe(true)
    expect(finalizeExamAttemptRecord(attempt, NaN)).toEqual({ finalized: false, reason: 'invalidTime', attempt })
  })
})
