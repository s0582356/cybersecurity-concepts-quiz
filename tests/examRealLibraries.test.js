// Exam-Core gegen die echten finalen V2-Libraries (nur lesend). Läuft nur mit
// SECURITY_REPO_PATH=<security-repo>; die Dateien werden nie ins App-Repo kopiert.
import 'fake-indexeddb/auto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createProgressStore } from '../src/storage/progressStore.js'
import { readExamPool, startExam } from '../src/storage/examService.js'
import { presentExamQuestion } from '../src/domain/examAttempt.js'
import { importExamLibraries, seededRandom } from './fixtures/examFixtures.js'

const root = process.env.SECURITY_REPO_PATH

describe.skipIf(!root || !existsSync(root))('exam core with the real libraries (local security repo)', () => {
  const dir = root ? join(root, 'audit/final') : ''
  let store
  let files

  beforeEach(async () => {
    files = readdirSync(dir)
      .filter((name) => /^security-plus-v2-la\d\d-.*\.json$/.test(name))
      .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')))
    store = createProgressStore({ dbName: `exam-real-${Math.random().toString(36).slice(2)}` })
    await store.initialize()

    await importExamLibraries(store, files)
  })

  afterEach(() => store.close())

  it('pool = all active questions of all libraries (computed from the files)', async () => {
    const expected = files.flatMap((data) => data.questions.filter((question) => question.status === 'active'))
    const { pool, libraries, excludedLibraryIds } = await readExamPool(store)

    expect(libraries).toHaveLength(files.length)
    expect(excludedLibraryIds).toEqual([])
    expect(pool).toHaveLength(expected.length)
    expect(new Set(pool.map((entry) => entry.question.id)).size).toBe(expected.length)
    expect(new Set(pool.map((entry) => entry.sectionId)).size).toBe(new Set(expected.map((question) => question.learningSectionId)).size)
  })

  it.each([
    ['de', 20],
    ['de', 45],
    ['de', 90],
    ['en', 20],
    ['en', 45],
    ['en', 90],
  ])('starts a %s exam with %i unique questions, every section represented as far as the count allows', async (language, count) => {
    const { attempt } = await startExam(store, { language, count, random: seededRandom(count) })
    const sections = new Set(attempt.orderedQuestionIds.map((id) => attempt.questionSnapshots[id].sectionId))

    expect(attempt.questionCount).toBe(count)
    expect(new Set(attempt.orderedQuestionIds).size).toBe(count)
    expect(sections.size).toBe(9)
    expect(attempt.skippedForLanguage).toBe(0)

    const view = presentExamQuestion(attempt, attempt.orderedQuestionIds[0])

    expect(JSON.stringify(view)).not.toContain(attempt.questionSnapshots[attempt.orderedQuestionIds[0]].content.explanation)
  })
})
