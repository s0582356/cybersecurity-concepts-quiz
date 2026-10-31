import { describe, expect, it } from 'vitest'
import {
  CONTENT_PROBLEM,
  LANGUAGE_MODE,
  MEMORY_AID_TYPES,
  canPresentRound,
  planRoundQuestions,
  validateEnglishContent,
  OPTION_KEYS,
  coverageOf,
  displayedOptionOrder,
  normalizeStoredQuestion,
  presentQuestion,
  relocalizeQuestion,
  resolveQuestionContent,
  validateLocalizedContent,
} from '../src/domain/questionContent.js'
import { parseQuestionFile, parseV2Library } from '../src/lib/library/parseLibrary.js'
import { makeSyntheticLibrary } from './fixtures/syntheticLibrary.js'

const parsed = (options = {}) => parseV2Library(makeSyntheticLibrary({ count: 4, ...options }))
const first = (options) => parsed(options).questions[0]

describe('validateLocalizedContent', () => {
  const valid = () => ({
    question: 'Q?',
    optionText: { a: '1', b: '2', c: '3', d: '4' },
    explanation: 'E',
    memoryAid: { type: 'mnemonic', text: 'M' },
  })

  it('accepts a complete English version (all schema-required fields incl. memoryAid)', () => {
    expect(validateEnglishContent(valid()).valid).toBe(true)
    MEMORY_AID_TYPES.forEach((type) => expect(validateEnglishContent({ ...valid(), memoryAid: { type, text: 'M' } }).valid).toBe(true))
  })

  it('English without memoryAid is invalid (schema: memoryAid is required in every localized version)', () => {
    const withoutAid = valid()

    delete withoutAid.memoryAid
    expect(validateEnglishContent(withoutAid)).toEqual({ valid: false, problem: CONTENT_PROBLEM.MEMORY_AID })
    expect(validateEnglishContent({ ...withoutAid, memoryAid: null }).valid).toBe(false)
    expect(validateEnglishContent({ ...valid(), memoryAid: { type: 'mnemonic' } }).valid).toBe(false)
    expect(validateEnglishContent({ ...valid(), memoryAid: { text: 'M' } }).valid).toBe(false)
    expect(validateEnglishContent({ ...valid(), memoryAid: { type: 'not_in_schema', text: 'M' } }).valid).toBe(false)
    expect(validateEnglishContent({ ...valid(), memoryAid: 'text' }).valid).toBe(false)
  })

  it('the German base view stays lenient (older stored content has no memoryAid) but must be well-formed if present', () => {
    const withoutAid = valid()

    delete withoutAid.memoryAid
    expect(validateLocalizedContent(withoutAid).valid).toBe(true)
    expect(validateLocalizedContent({ ...valid(), memoryAid: { type: 'mnemonic' } }).valid).toBe(false)
  })

  it.each([
    ['missing', null, CONTENT_PROBLEM.MISSING],
    ['not an object', 'text', CONTENT_PROBLEM.NOT_AN_OBJECT],
    ['no question text', { ...valid(), question: ' ' }, CONTENT_PROBLEM.QUESTION],
    ['no options', { ...valid(), optionText: undefined }, CONTENT_PROBLEM.OPTIONS_MISSING],
    ['too few options', { ...valid(), optionText: { a: '1', b: '2', c: '3' } }, CONTENT_PROBLEM.OPTION_KEYS],
    ['wrong option keys', { ...valid(), optionText: { a: '1', b: '2', c: '3', x: '4' } }, CONTENT_PROBLEM.OPTION_KEYS],
    ['extra option key', { ...valid(), optionText: { a: '1', b: '2', c: '3', d: '4', e: '5' } }, CONTENT_PROBLEM.OPTION_KEYS],
    ['empty option text', { ...valid(), optionText: { a: '1', b: '', c: '3', d: '4' } }, CONTENT_PROBLEM.OPTION_TEXT],
    ['duplicate option texts', { ...valid(), optionText: { a: '1', b: '1', c: '3', d: '4' } }, CONTENT_PROBLEM.OPTIONS_NOT_UNIQUE],
    ['no explanation', { ...valid(), explanation: '' }, CONTENT_PROBLEM.EXPLANATION],
    ['broken memory aid', { ...valid(), memoryAid: { type: 'mnemonic' } }, CONTENT_PROBLEM.MEMORY_AID],
  ])('rejects %s without crashing', (name, content, problem) => {
    expect(validateLocalizedContent(content)).toEqual({ valid: false, problem })
  })
})

describe('content resolver', () => {
  it('German-only question renders German and flags English as fallback', () => {
    const question = first()

    expect(resolveQuestionContent(question, 'de')).toMatchObject({ language: 'de', fallback: false })
    expect(resolveQuestionContent(question, 'en')).toMatchObject({ language: 'de', fallback: true })
    expect(presentQuestion(question, 'en').question).toBe(question.localized.de.question)
  })

  it('bilingual question renders English with the same id, option keys and correct option', () => {
    const question = first({ english: 'all' })
    const german = presentQuestion(question, 'de')
    const english = presentQuestion(question, 'en')

    expect(english.id).toBe(german.id)
    expect(english.contentLanguage).toBe('en')
    expect(english.question).toBe('Synthetische Frage EN 0001?')
    expect(Object.keys(english.optionTextByKey)).toEqual(Object.keys(german.optionTextByKey))
    expect(Object.keys(english.optionTextByKey)).toEqual(OPTION_KEYS)
    expect(english.correctOptionKey).toBe(german.correctOptionKey)
    expect(english.correctAnswer).toBe(english.optionTextByKey[question.correctOptionKey])
    expect(german.correctAnswer).toBe(german.optionTextByKey[question.correctOptionKey])
    expect(english.explanation).not.toBe(german.explanation)
    expect(english.memoryAid.text).toBe('Synthetic memory aid 0001.')
    expect(german.memoryAid.text).toBe('Synthetisch.')
  })

  it('never takes the German text as English: an unknown locale falls back to German, flagged', () => {
    const question = first({ english: 'all' })

    expect(resolveQuestionContent(question, 'fr')).toMatchObject({ language: 'de', fallback: true })
    expect(resolveQuestionContent(question, undefined).language).toBe('de')
    expect(resolveQuestionContent({ id: 'x' }, 'en').content).toBeNull()
  })

  it('keeps the shown option order (keys) when only the language changes', () => {
    const question = first({ english: 'all' })
    const shown = presentQuestion(question, 'de', { optionOrder: ['d', 'b', 'a', 'c'] })
    const switched = relocalizeQuestion(shown, 'en')

    expect(displayedOptionOrder(shown)).toEqual(['d', 'b', 'a', 'c'])
    expect(displayedOptionOrder(switched)).toEqual(['d', 'b', 'a', 'c'])
    expect(switched.options).toEqual(['d', 'b', 'a', 'c'].map((key) => question.localized.en.optionText[key]))
    expect(switched.correctAnswer).toBe(question.localized.en.optionText[question.correctOptionKey])
    expect(relocalizeQuestion(switched, 'de').options).toEqual(shown.options)
  })

  it('passes V1 / public sample questions through untouched', () => {
    const v1 = { id: 1, question: 'Q?', options: ['a', 'b'], correctAnswer: 'a', explanation: 'E' }

    expect(presentQuestion(v1, 'en')).toBe(v1)
    expect(relocalizeQuestion(v1, 'en')).toBe(v1)
  })

  it('derives the German version from questions stored by Phase 2E (flat only)', () => {
    const flat = {
      id: 'sec-a30-0001', libraryId: 'lib', question: 'Q?', options: ['1', '2', '3', '4'], correctAnswer: '3',
      explanation: 'E', optionTextByKey: { a: '1', b: '2', c: '3', d: '4' },
    }
    const upgraded = normalizeStoredQuestion(flat)

    expect(upgraded.correctOptionKey).toBe('c')
    expect(upgraded.localized.en).toBeNull()
    expect(presentQuestion(upgraded, 'de').correctAnswer).toBe('3')
  })
})

describe('coverage and parser', () => {
  it('counts only structurally valid English as available', () => {
    const library = makeSyntheticLibrary({
      count: 5,
      english: 'all',
      englishOverrides: {
        'sec-a30-0002': null,
        'sec-a30-0003': { question: 'Q', optionText: { a: '1', b: '2', c: '3', x: '4' }, explanation: 'E' },
        'sec-a30-0004': { question: 'Q', optionText: { a: '1', b: '2', c: '3' }, explanation: 'E' },
      },
    })
    const { library: meta, questions } = parseV2Library(library)

    expect(meta.contentCoverage).toEqual({ de: 5, en: 2 })
    expect(meta.languageSupport).toEqual(['de', 'en'])
    expect(meta.languageIssues.map((issue) => issue.problem).sort()).toEqual([CONTENT_PROBLEM.OPTION_KEYS, CONTENT_PROBLEM.OPTION_KEYS])
    expect(questions[2].localized.en).toBeNull()
    expect(coverageOf(questions)).toMatchObject({ total: 5, de: 5, en: 2, englishComplete: false })
  })

  it('does not trust languageSupport: declared en without content is not coverage', () => {
    const { library, questions } = parsed({ english: 'none', languageSupport: ['de', 'en'] })

    expect(library.languageSupport).toEqual(['de', 'en'])
    expect(library.contentCoverage.en).toBe(0)
    expect(coverageOf(questions).englishComplete).toBe(false)
  })

  it('reports complete English even if it is not declared', () => {
    const { library } = parsed({ english: 'all', languageSupport: ['de'] })

    expect(library.contentCoverage).toEqual({ de: 4, en: 4 })
    expect(library.languageSupport).toEqual(['de'])
  })

  it('records unknown locale keys as an issue and never crashes', () => {
    const data = makeSyntheticLibrary({ count: 2 })

    data.questions[0].localized.fr = { question: 'Q' }

    const { library } = parseQuestionFile(data)

    expect(library.languageIssues).toEqual([{ id: 'sec-a30-0001', locale: 'fr', problem: 'unknownLocale' }])
  })

  it('German content, ids and revisions are identical with and without English (baseline unchanged)', () => {
    const german = parsed({ english: 'none' })
    const bilingual = parsed({ english: 'all' })

    expect(bilingual.library.questionRevisions).toEqual(german.library.questionRevisions)
    expect(bilingual.questions.map((question) => [question.id, question.question, question.options, question.correctAnswer])).toEqual(
      german.questions.map((question) => [question.id, question.question, question.options, question.correctAnswer]),
    )
  })
})

describe('round planning (contract fallback policy)', () => {
  // 10 Fragen, davon 6 mit gültigem EN; 0007 hat EN ohne memoryAid (ungültig), 0008 EN mit unvollständigen Optionen.
  const mixed = () => {
    const english = ['sec-a30-0001', 'sec-a30-0002', 'sec-a30-0003', 'sec-a30-0004', 'sec-a30-0005', 'sec-a30-0006', 'sec-a30-0007', 'sec-a30-0008']
    const data = makeSyntheticLibrary({ count: 10, english })
    const withoutAid = { ...data.questions[6].localized.en }

    delete withoutAid.memoryAid
    data.questions[6].localized.en = withoutAid
    data.questions[7].localized.en = { ...data.questions[7].localized.en, optionText: { a: '1', b: '2', c: '3' } }

    return parseV2Library(data)
  }

  it('fixture sanity: full bilingual, DE-only and mixed questions', () => {
    const { library, questions } = mixed()

    expect(library.contentCoverage).toEqual({ de: 10, en: 6 })
    expect(questions.filter((question) => question.localized.en).map((question) => question.id)).toHaveLength(6)
    expect(library.languageIssues).toHaveLength(2)
  })

  it('German: all questions, no mode', () => {
    const plan = planRoundQuestions(mixed().questions, { language: 'de', mode: LANGUAGE_MODE.ONLY_ENGLISH })

    expect(plan).toMatchObject({ language: 'de', mode: null, skippedQuestionIds: [] })
    expect(plan.questions).toHaveLength(10)
  })

  it('"Nur Englisch": exactly the 6 questions with valid English, the other 4 reported as skipped', () => {
    const { questions } = mixed()
    const plan = planRoundQuestions(questions, { language: 'en', mode: LANGUAGE_MODE.ONLY_ENGLISH })

    expect(plan.questions.map((question) => question.id)).toEqual(questions.slice(0, 6).map((question) => question.id))
    expect(plan.skippedQuestionIds).toEqual(questions.slice(6).map((question) => question.id))
    expect(plan.questions.every((question) => question.localized.en)).toBe(true)
  })

  it('"Alle verfügbaren Fragen": all 10; those without valid English show the marked German fallback', () => {
    const { questions } = mixed()
    const plan = planRoundQuestions(questions, { language: 'en', mode: LANGUAGE_MODE.ALL_AVAILABLE })
    const views = plan.questions.map((question) => presentQuestion(question, 'en'))

    expect(plan.questions).toHaveLength(10)
    expect(plan.skippedQuestionIds).toEqual([])
    expect(views.filter((view) => !view.languageFallback)).toHaveLength(6)
    expect(views.filter((view) => view.languageFallback).every((view) => view.contentLanguage === 'de')).toBe(true)
    // Ungültiges EN (ohne memoryAid / unvollständige Optionen) wird nie als Englisch gezeigt.
    expect(views[6].question).toBe(questions[6].localized.de.question)
    expect(views[7].question).toBe(questions[7].localized.de.question)
  })

  it('a running round can only be shown in English if every round question has English (or runs in "all available")', () => {
    const { questions } = mixed()

    expect(canPresentRound(questions.slice(0, 6), { language: 'en', mode: LANGUAGE_MODE.ONLY_ENGLISH })).toEqual({ possible: true, missing: 0 })
    expect(canPresentRound(questions, { language: 'en', mode: null })).toEqual({ possible: false, missing: 4 })
    expect(canPresentRound(questions, { language: 'en', mode: LANGUAGE_MODE.ALL_AVAILABLE }).possible).toBe(true)
    expect(canPresentRound(questions, { language: 'de', mode: null }).possible).toBe(true)
  })

  it('a section without any English yields an empty "Nur Englisch" plan (controlled, not a crash)', () => {
    const plan = planRoundQuestions(parseV2Library(makeSyntheticLibrary({ count: 3 })).questions, { language: 'en', mode: LANGUAGE_MODE.ONLY_ENGLISH })

    expect(plan.questions).toEqual([])
    expect(plan.skippedQuestionIds).toHaveLength(3)
  })
})
