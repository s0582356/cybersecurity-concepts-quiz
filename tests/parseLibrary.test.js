import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  LibraryParseError,
  parseQuestionFile,
  parseV2Library,
} from '../src/lib/library/parseLibrary.js'
import { makeSyntheticLibrary, V1_QUESTIONS } from './fixtures/syntheticLibrary.js'

describe('V2 parser', () => {
  it('accepts a synthetic V2 library', () => {
    const result = parseQuestionFile(makeSyntheticLibrary({ count: 24 }))

    expect(result.format).toBe('v2')
    expect(result.questions).toHaveLength(24)
  })

  // Optional gegen die echte (private, nicht eingecheckte) Pilot-Library:
  //   V2_PILOT_LIBRARY_PATH=/pfad/security-plus-v2-la08-sec23.json npm test
  it.skipIf(!process.env.V2_PILOT_LIBRARY_PATH)('accepts the real pilot library when provided locally', () => {
    const data = JSON.parse(readFileSync(process.env.V2_PILOT_LIBRARY_PATH, 'utf8'))
    const result = parseQuestionFile(data)

    expect(result.format).toBe('v2')
    expect(result.library.libraryId).toBe('security-plus-v2-la08-sec23')
    expect(result.library.libraryVersion).toBe('1.0.1')
    expect(result.questions).toHaveLength(24)
  })

  it('reads library metadata', () => {
    const { library } = parseV2Library(
      makeSyntheticLibrary({ libraryId: 'meta-test', libraryVersion: '2.3.4' }),
    )

    expect(library).toMatchObject({
      schemaVersion: '2.0.0',
      libraryId: 'meta-test',
      libraryVersion: '2.3.4',
      activeQuestionIndexHash: `sha256:${'a'.repeat(64)}`,
      sourceSections: [30],
    })
  })

  it('uses the stable question.id, not text or position', () => {
    const data = makeSyntheticLibrary({ count: 3 })
    const { questions } = parseV2Library(data)

    expect(questions.map((question) => question.id)).toEqual(data.questions.map((question) => question.id))
    expect(questions.every((question) => question.libraryId === data.libraryId)).toBe(true)

    const reversed = { ...data, questions: [...data.questions].reverse() }

    expect(parseV2Library(reversed).questions.map((question) => question.id)).toEqual(
      [...data.questions].reverse().map((question) => question.id),
    )
  })

  it('maps the correct option key to the correct answer text', () => {
    const data = makeSyntheticLibrary({ count: 4 })
    const { questions } = parseV2Library(data)

    data.questions.forEach((source, index) => {
      expect(questions[index].correctAnswer).toBe(source.localized.de.optionText[source.correctOptionKey])
      expect(questions[index].options).toHaveLength(4)
    })
  })

  it('rejects duplicate question IDs', () => {
    const data = makeSyntheticLibrary({ count: 3 })
    data.questions[2].id = data.questions[0].id

    expect(() => parseV2Library(data)).toThrow(/doppelte Question-ID/)
  })

  describe('malformed V2 files', () => {
    const cases = {
      'missing schemaVersion': (data) => delete data.schemaVersion,
      'unsupported schemaVersion': (data) => (data.schemaVersion = '3.0.0'),
      'missing libraryId': (data) => delete data.libraryId,
      'invalid libraryId': (data) => (data.libraryId = 'Not Valid!'),
      'missing libraryVersion': (data) => delete data.libraryVersion,
      'missing activeQuestionIndexHash': (data) => delete data.activeQuestionIndexHash,
      'malformed hash': (data) => (data.activeQuestionIndexHash = 'sha256:xyz'),
      'questions not an array': (data) => (data.questions = {}),
      'empty questions': (data) => {
        data.questions = []
        data.questionCount = 0
      },
      'questionCount mismatch': (data) => (data.questionCount = 99),
      'question without id': (data) => delete data.questions[0].id,
      'question with invalid id': (data) => (data.questions[0].id = 'q-1'),
      'missing German text': (data) => (data.questions[0].localized.de = null),
      'missing option': (data) => delete data.questions[0].localized.de.optionText.d,
      'invalid correctOptionKey': (data) => (data.questions[0].correctOptionKey = 'e'),
      'duplicate option texts': (data) =>
        (data.questions[0].localized.de.optionText.b = data.questions[0].localized.de.optionText.a),
    }

    Object.entries(cases).forEach(([name, mutate]) => {
      it(`rejects: ${name}`, () => {
        const data = makeSyntheticLibrary()
        mutate(data)

        expect(() => parseQuestionFile(data)).toThrow(LibraryParseError)
      })
    })

    it('rejects non-JSON-object content', () => {
      expect(() => parseQuestionFile('text')).toThrow(LibraryParseError)
      expect(() => parseQuestionFile(null)).toThrow(LibraryParseError)
    })
  })
})

describe('V1 parser', () => {
  it('stays compatible with the flat question array', () => {
    const result = parseQuestionFile(V1_QUESTIONS)

    expect(result.format).toBe('v1')
    expect(result.library).toBeNull()
    expect(result.questions).toEqual(V1_QUESTIONS)
  })

  it('keeps the V1 defaults and error messages', () => {
    const [question] = parseQuestionFile([
      { question: 'F?', options: ['a', 'b'], correctAnswer: 'a', explanation: 'E' },
    ]).questions

    expect(question).toMatchObject({ id: 1, category: 'Private Practice', difficulty: 'private' })
    expect(() => parseQuestionFile([])).toThrow('Die JSON-Datei enthält keine Fragen.')
    expect(() => parseQuestionFile([{ question: 'F?' }])).toThrow(/"options" muss mindestens zwei/)
  })
})
