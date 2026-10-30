import { describe, expect, it } from 'vitest'
import {
  SESSION_STATUS,
  advanceSession,
  applyAnswer,
  applyOptionOrder,
  completeSession,
  createSessionRecord,
  evaluateSession,
  optionOrderOf,
  sessionStats,
  shuffled,
} from '../src/domain/session.js'
import { parseV2Library } from '../src/lib/library/parseLibrary.js'
import { makeSyntheticLibrary } from './fixtures/syntheticLibrary.js'

function setup(count = 4) {
  const { library, questions } = parseV2Library(makeSyntheticLibrary({ count }))
  const ids = shuffled(questions.map((question) => question.id), () => 0.3)
  const session = createSessionRecord({
    sessionId: 'session-1',
    library,
    orderedQuestionIds: ids,
    optionOrder: ['a', 'b', 'c', 'd'],
    now: 1000,
  })

  return { library, questions, ids, session }
}

describe('session record', () => {
  it('creates a learning session with the ordered question IDs and a first position', () => {
    const { session, ids, library } = setup()

    expect(session).toMatchObject({
      sessionId: 'session-1',
      libraryId: library.libraryId,
      activeQuestionIndexHash: library.activeQuestionIndexHash,
      sessionMode: 'learning',
      currentQuestionId: ids[0],
      currentIndex: 0,
      answeredQuestionIds: [],
      sessionCorrectCount: 0,
      sessionIncorrectCount: 0,
      sessionStartedAt: 1000,
      lastResumedAt: 1000,
      completed: false,
    })
    expect(session.orderedQuestionIds).toEqual(ids)
  })

  it('contains only stable question IDs, each exactly once', () => {
    const { session, questions } = setup(24)

    expect([...session.orderedQuestionIds].sort()).toEqual(questions.map((question) => question.id).sort())
    expect(session.orderedQuestionIds.every((id) => /^sec-a\d{2}-\d{4}$/.test(id))).toBe(true)
    expect(JSON.stringify(session)).not.toContain('Synthetische Frage')
  })

  it('shuffles with an injectable random source and keeps all items', () => {
    const items = [1, 2, 3, 4, 5, 6]

    expect(shuffled(items, () => 0)).toEqual(shuffled(items, () => 0))
    expect([...shuffled(items)].sort()).toEqual(items)
    expect(items).toEqual([1, 2, 3, 4, 5, 6])
  })
})

describe('answer events', () => {
  it('counts a session answer once and keeps session streaks', () => {
    const { session, ids } = setup()
    const first = applyAnswer(session, { questionId: ids[0], isCorrect: true, selectedOptionKey: 'b' })
    const duplicate = applyAnswer(first.session, { questionId: ids[0], isCorrect: true })
    const second = applyAnswer(first.session, { questionId: ids[1], isCorrect: false, selectedOptionKey: 'a' })
    const third = applyAnswer(second.session, { questionId: ids[2], isCorrect: true })

    expect(first.applied).toBe(true)
    expect(duplicate).toMatchObject({ applied: false, reason: 'duplicate' })
    expect(third.session).toMatchObject({
      sessionCorrectCount: 2,
      sessionIncorrectCount: 1,
      currentStreak: 1,
      bestSessionStreak: 1,
      answeredQuestionIds: [ids[0], ids[1], ids[2]],
    })
    expect(sessionStats(third.session)).toEqual({
      totalCount: 4,
      answeredCount: 3,
      correctCount: 2,
      incorrectCount: 1,
      remainingCount: 1,
    })
  })

  it('rejects answers for unknown questions and completed sessions', () => {
    const { session } = setup()

    expect(applyAnswer(session, { questionId: 'sec-a30-9999', isCorrect: true })).toMatchObject({
      applied: false,
      reason: 'unknownQuestion',
    })
    expect(
      applyAnswer(completeSession(session), { questionId: session.currentQuestionId, isCorrect: true }),
    ).toMatchObject({ applied: false, reason: 'completed' })
  })

  it('advancing changes position and discards the UI state of the previous question', () => {
    const { session, ids } = setup()
    const answered = applyAnswer(session, { questionId: ids[0], isCorrect: true, selectedOptionKey: 'c' }).session
    const advanced = advanceSession(answered, { questionId: ids[1], optionOrder: ['d', 'c', 'b', 'a'] })

    expect(advanced).toMatchObject({ currentQuestionId: ids[1], currentIndex: 1 })
    expect(advanced.currentQuestionState).toEqual({
      questionId: ids[1],
      optionOrder: ['d', 'c', 'b', 'a'],
      selectedOptionKey: null,
      isCorrect: null,
    })
    expect(() => advanceSession(answered, { questionId: 'sec-a30-9999' })).toThrow()
  })
})

describe('resume evaluation', () => {
  it('is none without a session and completed once completed', () => {
    const { library, questions, session } = setup()

    expect(evaluateSession(null, library, questions).status).toBe(SESSION_STATUS.NONE)
    expect(evaluateSession(completeSession(session, 5000), library, questions)).toMatchObject({
      status: SESSION_STATUS.COMPLETED,
      stats: { totalCount: 4, answeredCount: 0 },
    })
  })

  it('resumes the stored order and current question', () => {
    const { library, questions, session, ids } = setup()
    const advanced = advanceSession(session, { questionId: ids[2] })
    const result = evaluateSession(advanced, library, questions)

    expect(result.status).toBe(SESSION_STATUS.RESUMABLE)
    expect(result.orderedQuestions.map((question) => question.id)).toEqual(ids)
    expect(result.currentQuestionId).toBe(ids[2])
    expect(result.currentIndex).toBe(2)
    expect(result.indexCorrected).toBe(false)
  })

  it('lets currentQuestionId win over a conflicting currentIndex', () => {
    const { library, questions, session, ids } = setup()
    const result = evaluateSession({ ...session, currentQuestionId: ids[3], currentIndex: 1 }, library, questions)

    expect(result).toMatchObject({ status: SESSION_STATUS.RESUMABLE, currentIndex: 3, indexCorrected: true })
    expect(result.currentQuestionId).toBe(ids[3])
  })

  it('falls back to a valid stored index only if the ID is unusable, otherwise blocks', () => {
    const { library, questions, session, ids } = setup()

    expect(
      evaluateSession({ ...session, currentQuestionId: null, currentIndex: 2 }, library, questions),
    ).toMatchObject({ status: SESSION_STATUS.RESUMABLE, currentQuestionId: ids[2], currentIndex: 2 })
    expect(
      evaluateSession({ ...session, currentQuestionId: 'sec-a30-9999', currentIndex: 99 }, library, questions),
    ).toMatchObject({ status: SESSION_STATUS.RESUME_REQUIRES_MIGRATION, reason: 'currentQuestionMissing' })
  })

  it('does not silently resume when a stored question is missing in the library', () => {
    const { library, questions, session, ids } = setup()
    const reduced = questions.filter((question) => question.id !== ids[1])
    const result = evaluateSession(session, library, reduced)

    expect(result).toMatchObject({
      status: SESSION_STATUS.RESUME_REQUIRES_MIGRATION,
      reason: 'questionsChanged',
      missingQuestionIds: [ids[1]],
    })
  })

  it('does not silently resume when the library has additional questions', () => {
    const { library, questions, session } = setup()
    const extended = [...questions, { ...questions[0], id: 'sec-a30-0099' }]

    expect(evaluateSession(session, library, extended)).toMatchObject({
      status: SESSION_STATUS.RESUME_REQUIRES_MIGRATION,
      extraQuestionIds: ['sec-a30-0099'],
    })
  })

  it('does not silently resume against a different activeQuestionIndexHash', () => {
    const { library, questions, session } = setup()
    const changed = { ...library, activeQuestionIndexHash: `sha256:${'f'.repeat(64)}` }

    expect(evaluateSession(session, changed, questions)).toMatchObject({
      status: SESSION_STATUS.RESUME_REQUIRES_MIGRATION,
      reason: 'hashChanged',
    })
  })

  it('blocks structurally corrupt sessions', () => {
    const { library, questions, session, ids } = setup()

    expect(evaluateSession({ ...session, answeredQuestionIds: ['sec-a30-9999'] }, library, questions)).toMatchObject({
      reason: 'invalidSession',
    })
    expect(
      evaluateSession({ ...session, orderedQuestionIds: [ids[0], ids[0]] }, library, questions),
    ).toMatchObject({ reason: 'invalidSession' })
  })

  it('derives stats from the lists, so stored counters cannot double count', () => {
    const { library, questions, session, ids } = setup()
    const answered = applyAnswer(session, { questionId: ids[0], isCorrect: true }).session
    const tampered = { ...answered, sessionCorrectCount: 7, sessionIncorrectCount: 7 }

    expect(evaluateSession(tampered, library, questions).stats).toMatchObject({
      answeredCount: 1,
      correctCount: 1,
      incorrectCount: 0,
      remainingCount: 3,
    })
  })
})

describe('question-specific UI state', () => {
  it('is restored for the same question ID only', () => {
    const { library, questions, session, ids } = setup()
    const answered = applyAnswer(session, { questionId: ids[0], isCorrect: false, selectedOptionKey: 'd' }).session

    expect(evaluateSession(answered, library, questions).currentState).toMatchObject({
      questionId: ids[0],
      selectedOptionKey: 'd',
    })

    // Zustand einer anderen Frage wird nie auf die aktuelle übertragen.
    const foreign = { ...answered, currentQuestionState: { ...answered.currentQuestionState, questionId: ids[1] } }

    expect(evaluateSession(foreign, library, questions).currentState).toBeNull()
  })

  it('converts option order between keys and displayed texts', () => {
    const { questions } = setup()
    const question = applyOptionOrder(questions[0], ['d', 'a', 'c', 'b'])

    expect(question.options).toEqual(['d', 'a', 'c', 'b'].map((key) => questions[0].optionTextByKey[key]))
    expect(optionOrderOf(question)).toEqual(['d', 'a', 'c', 'b'])
    expect(applyOptionOrder(questions[0], ['a', 'a', 'c', 'b'])).toBe(questions[0])
  })

  it('does not store option texts or the selected text in the session', () => {
    const { session, ids } = setup()
    const answered = applyAnswer(session, { questionId: ids[0], isCorrect: true, selectedOptionKey: 'b' }).session

    expect(JSON.stringify(answered)).not.toContain('Synthetisch')
  })
})
