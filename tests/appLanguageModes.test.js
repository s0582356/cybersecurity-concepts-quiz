// @vitest-environment jsdom
// Contract-Fix Phase 2F: "Nur Englisch" / "Alle verfügbaren Fragen", Sitzungssprache im Resume-Datensatz.
import 'fake-indexeddb/auto'
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  answerButtons,
  buttonByText,
  chooseLanguageOption,
  heading,
  importFiles,
  mountApp,
  next,
  openSection,
  reloadWithoutImport,
  resetBrowserStorage,
  resume,
  scoreText,
  sectionCard,
  settle,
  startQuiz,
  switchLanguage,
  unmountAll,
  withStore,
} from './helpers/appHarness.js'
import { loadLanguagePreference } from '../src/i18n/index.js'
import { makeSyntheticLibrary } from './fixtures/syntheticLibrary.js'

beforeEach(() => {
  resetBrowserStorage()
  loadLanguagePreference()
})
afterEach(unmountAll)

const hash = (char) => `sha256:${char.repeat(64)}`
const ids = (prefix, from, to) => Array.from({ length: to - from + 1 }, (_, index) => `${prefix}-${String(from + index).padStart(4, '0')}`)
const lib = (libraryId, prefix, options = {}) =>
  makeSyntheticLibrary({
    libraryId,
    idPrefix: prefix,
    questionLabel: `${libraryId} Frage`,
    activeQuestionIndexHash: hash(libraryId.length.toString(16).slice(-1)),
    ...options,
  })
const file = (data) => ({ name: `${data.libraryId}.json`, data })

// Section mit 10 Fragen, davon 6 mit gültigem EN (0001–0006).
const mixed = lib('lib-mix', 'sec-a30', { count: 10, english: ids('sec-a30', 1, 6) })
const mixedIds = mixed.questions.map((question) => question.id)
const englishIds = new Set(ids('sec-a30', 1, 6))
const isEnglishHeading = (text) => text.includes(' EN ')

async function answerAny(container, libraries) {
  const all = libraries.flatMap((data) => data.questions)
  const shown = heading(container)
  const question = all.find((item) => item.localized.de.question === shown || item.localized.en?.question === shown)
  const language = question.localized.de.question === shown ? 'de' : 'en'
  const expected = question.localized[language].optionText[question.correctOptionKey]

  answerButtons(container).find((button) => button.textContent.trim() === expected).click()
  await nextTick()

  return question.id
}

const session = () => withStore((store) => store.getLatestSectionSession('la99'))

async function importAndOpenEnglish(libraries, option = 'en-only') {
  const app = mountApp()

  await settle()
  await switchLanguage(app.container, 'en')
  await importFiles(app.container, libraries.map(file))
  await openSection(app.container, 'Learning section 99')
  await chooseLanguageOption(app.container, option)

  return app
}

describe('mode "English only" (Nur Englisch)', () => {
  it('the round contains exactly the 6 questions with valid English; no German-only question, no mixed language', async () => {
    const app = await importAndOpenEnglish([mixed])

    expect(app.container.querySelector('.language-preview').textContent).toContain('contains 6 of 10 questions')
    await startQuiz(app.container)
    await settle()

    const stored = await session()

    expect(stored.orderedQuestionIds).toHaveLength(6)
    expect(new Set(stored.orderedQuestionIds)).toEqual(englishIds)
    expect(stored).toMatchObject({ sessionLanguage: 'en', languageMode: 'onlyEnglish' })
    expect([...stored.skippedQuestionIds].sort()).toEqual(mixedIds.slice(6))
    expect(scoreText(app.container)).toContain('Question 1 of 6')
    expect(app.container.querySelector('.language-note').textContent).toContain(
      '4 of 10 questions in this learning section are not yet available in English and were not shown in this session.',
    )

    for (let index = 0; index < 6; index++) {
      expect(isEnglishHeading(heading(app.container))).toBe(true)
      expect(app.container.querySelector('.language-fallback-badge')).toBeNull()
      await answerAny(app.container, [mixed])

      if (index < 5) {
        await next(app.container)
      }
    }

    buttonByText(app.container, 'Show results').click()
    await nextTick()
    expect(app.container.querySelector('.result-card .language-note').textContent).toContain('4 of 10 questions')
  })

  it('English with a missing memoryAid or incomplete options is not counted and not shown', async () => {
    const data = lib('lib-bad', 'sec-a30', {
      count: 4,
      english: 'all',
      englishOverrides: {
        'sec-a30-0003': { question: 'Q', optionText: { a: '1', b: '2', c: '3', d: '4' }, explanation: 'E' },
        'sec-a30-0004': { question: 'Q', optionText: { a: '1', b: '2', c: '3' }, explanation: 'E', memoryAid: { type: 'mnemonic', text: 'M' } },
      },
    })
    const app = await importAndOpenEnglish([data])

    expect(sectionCard(app.container, 'Learning section 99').textContent).toContain('English incomplete (2/4)')
    await startQuiz(app.container)
    await settle()
    expect(new Set((await session()).orderedQuestionIds)).toEqual(new Set(['sec-a30-0001', 'sec-a30-0002']))
  })

  it('a section without any English cannot start an English-only round (controlled message, nothing written)', async () => {
    const app = await importAndOpenEnglish([lib('lib-de', 'sec-a31', { count: 3 })])

    buttonByText(app.container, 'Start learning round').click()
    await settle()
    expect(app.container.querySelector('.library-message-error').textContent).toContain('no English questions')
    expect(await session()).toBeNull()
  })

  it('multi-library section: the English-only set is collected across libraries with stable ids', async () => {
    const a = lib('lib-a', 'sec-a30', { count: 3, english: 'all' })
    const b = lib('lib-b', 'sec-a31', { count: 3, english: ['sec-a31-0002'] })
    const app = await importAndOpenEnglish([a, b])

    await startQuiz(app.container)
    await settle()

    const stored = await session()

    expect(new Set(stored.orderedQuestionIds)).toEqual(new Set(['sec-a30-0001', 'sec-a30-0002', 'sec-a30-0003', 'sec-a31-0002']))
    expect(stored.questionLibraries['sec-a31-0002']).toBe('lib-b')
    expect(stored.skippedQuestionIds.sort()).toEqual(['sec-a31-0001', 'sec-a31-0003'])
  })
})

describe('mode "All available questions" (Alle verfügbaren Fragen)', () => {
  it('contains all 10 questions; those without valid English are shown in German with a visible badge per question', async () => {
    const app = await importAndOpenEnglish([mixed], 'en-all')

    await startQuiz(app.container)
    await settle()

    const stored = await session()

    expect(new Set(stored.orderedQuestionIds)).toEqual(new Set(mixedIds))
    expect(stored).toMatchObject({ sessionLanguage: 'en', languageMode: 'allAvailable', skippedQuestionIds: [] })

    let english = 0
    let fallback = 0

    for (let index = 0; index < 10; index++) {
      const badge = app.container.querySelector('.language-fallback-badge')
      const id = await answerAny(app.container, [mixed])

      if (englishIds.has(id)) {
        english++
        expect(badge).toBeNull()
        expect(isEnglishHeading(heading(app.container))).toBe(true)
      } else {
        fallback++
        expect(badge.textContent).toContain('This question is not yet available in English')
        expect(isEnglishHeading(heading(app.container))).toBe(false)
      }

      if (index < 9) {
        await next(app.container)
      }
    }

    expect([english, fallback]).toEqual([6, 4])
    expect(app.container.querySelector('.language-note')).toBeNull()
  })
})

describe('session language and mode in the resume record', () => {
  it('stores the language and mode at round start and reproduces them after a reload (order, position, score, streak)', async () => {
    const first = await importAndOpenEnglish([mixed])

    await startQuiz(first.container)
    await answerAny(first.container, [mixed])
    await next(first.container)
    await answerAny(first.container, [mixed])
    await next(first.container)
    await settle()

    const before = await session()
    const shown = heading(first.container)
    const second = await reloadWithoutImport(first)

    await openSection(second.container, 'Learning section 99')
    expect(second.container.querySelector('.session-language').textContent).toContain('This round runs in English ("English only", 6 questions)')
    await resume(second.container)

    expect(heading(second.container)).toBe(shown)
    expect(scoreText(second.container)).toContain('Question 3 of 6')
    expect(scoreText(second.container)).toContain('Score: 2')
    expect(scoreText(second.container)).toContain('Current streak: 2')
    expect(await session()).toMatchObject({
      orderedQuestionIds: before.orderedQuestionIds,
      currentQuestionId: before.currentQuestionId,
      sessionLanguage: 'en',
      languageMode: 'onlyEnglish',
      skippedQuestionIds: before.skippedQuestionIds,
    })
  })

  it('a changed global preference does not silently change a stored round: same language, same set, visible note', async () => {
    const first = await importAndOpenEnglish([mixed])

    await startQuiz(first.container)
    await answerAny(first.container, [mixed])
    await settle()

    const before = await session()
    const second = await reloadWithoutImport(first)

    // Nach dem Neuladen (Startseite, keine laufende Runde): globale Auswahl auf Deutsch und danach "Alle verfügbaren".
    await switchLanguage(second.container, 'de')
    await openSection(second.container, 'Lernabschnitt 99')
    expect(second.container.querySelector('.session-language + .session-language').textContent).toContain(
      'Die gespeicherte Runde wird in ihrer Sprache und mit ihrer Fragenmenge fortgesetzt',
    )

    await resume(second.container)
    expect(isEnglishHeading(heading(second.container))).toBe(true)
    expect(scoreText(second.container)).toContain('Frage 1 von 6')
    // Einzige Änderung beim Fortsetzen ist der bisherige Zeitstempel `lastResumedAt`.
    expect({ ...(await session()), lastResumedAt: before.lastResumedAt }).toEqual(before)
  })

  it('an allowed in-round switch (set unchanged) is written to the session and survives a reload; the set stays the same', async () => {
    const first = await importAndOpenEnglish([mixed])

    await startQuiz(first.container)
    await answerAny(first.container, [mixed])
    await settle()

    const before = await session()

    await switchLanguage(first.container, 'de')
    await settle()
    expect(isEnglishHeading(heading(first.container))).toBe(false)

    const switched = await session()

    expect(switched.sessionLanguage).toBe('de')
    expect({ ...switched, sessionLanguage: 'en' }).toEqual(before)

    const second = await reloadWithoutImport(first)

    await openSection(second.container, 'Lernabschnitt 99')
    await resume(second.container)
    expect(isEnglishHeading(heading(second.container))).toBe(false)
    expect(scoreText(second.container)).toContain('Frage 1 von 6')
    expect(new Set((await session()).orderedQuestionIds)).toEqual(englishIds)
  })
})

describe('language switch that would change the question set', () => {
  async function runningGermanRound() {
    const app = mountApp()

    await settle()
    await importFiles(app.container, [file(mixed)])
    await openSection(app.container, 'Lernabschnitt 99')
    await startQuiz(app.container)
    await answerAny(app.container, [mixed])
    await settle()

    return app
  }

  it('switching a German round with untranslated questions to English does not mutate the running round', async () => {
    const app = await runningGermanRound()
    const before = await session()
    const shown = heading(app.container)

    expect(before.orderedQuestionIds).toHaveLength(10)
    await switchLanguage(app.container, 'en')
    await settle()

    expect(app.container.querySelector('.language-switch-notice').textContent).toContain('contains 4 of 10 questions without English content')
    expect(heading(app.container)).toBe(shown)
    expect(await session()).toEqual(before)
    expect(scoreText(app.container)).toContain('Question 1 of 10')
  })

  it('"Continue running round" keeps the round as it is and aligns the preference with it', async () => {
    const app = await runningGermanRound()
    const before = await session()

    await switchLanguage(app.container, 'en')
    buttonByText(app.container, 'Continue running round').click()
    await settle()
    expect(app.container.querySelector('.language-switch-notice')).toBeNull()
    expect(await session()).toEqual(before)
  })

  it('"Start new round in English" is an explicit decision: a new English-only round replaces the old one, progress stays', async () => {
    const app = await runningGermanRound()
    const before = await session()
    const progress = await withStore((store) => store.listAllProgress())

    await switchLanguage(app.container, 'en')
    buttonByText(app.container, 'Start new round in English').click()
    await vi.waitFor(() => expect(app.container.querySelector('.language-switch-notice')).toBeNull())
    await settle()

    const fresh = await session()

    expect(fresh.sessionId).not.toBe(before.sessionId)
    expect(new Set(fresh.orderedQuestionIds)).toEqual(englishIds)
    expect(fresh).toMatchObject({ sessionLanguage: 'en', languageMode: 'onlyEnglish' })
    expect(await withStore((store) => store.listAllProgress())).toEqual(progress)
  })

  it('changing the mode while a round is stored does not touch it; the new mode applies to the next round', async () => {
    const first = await importAndOpenEnglish([mixed])

    await startQuiz(first.container)
    await answerAny(first.container, [mixed])
    await settle()

    const before = await session()
    const second = await reloadWithoutImport(first)

    await switchLanguage(second.container, 'en')
    await openSection(second.container, 'Learning section 99')
    await chooseLanguageOption(second.container, 'en-all')
    expect(await session()).toEqual(before)
    expect(second.container.querySelector('.session-language + .session-language').textContent).toContain('only applies to the next round')

    await resume(second.container)
    expect(scoreText(second.container)).toContain('Question 1 of 6')
    expect(new Set((await session()).orderedQuestionIds)).toEqual(englishIds)

    // Neue Runde nach bewusstem Verwerfen: jetzt gilt der neue Modus (alle 10).
    const third = await reloadWithoutImport(second)

    await switchLanguage(third.container, 'en')
    await openSection(third.container, 'Learning section 99')
    buttonByText(third.container, 'Discard current round and start over').click()
    await vi.waitFor(() => expect(heading(third.container)).not.toBeNull())
    await settle()
    expect(await session()).toMatchObject({ languageMode: 'allAvailable' })
    expect((await session()).orderedQuestionIds).toHaveLength(10)
  })
})

describe('later import / update with running English round, progress and ids', () => {
  it('a running English-only round is not extended by new translations; they count as new for the next round', async () => {
    const a = lib('lib-a', 'sec-a30', { count: 3, english: 'all' })
    const b = lib('lib-b', 'sec-a31', { count: 3, english: ['sec-a31-0001'] })
    const first = await importAndOpenEnglish([a, b])

    await startQuiz(first.container)
    await answerAny(first.container, [a, b])
    await settle()

    const before = await session()

    expect(before.orderedQuestionIds).toHaveLength(4)

    // lib-b erhält vollständiges Englisch (Revision +1, höhere Version, neuer Hash) → normales Update.
    const bilingualB = lib('lib-b', 'sec-a31', {
      count: 3,
      english: 'all',
      libraryVersion: '1.1.0',
      activeQuestionIndexHash: hash('c'),
      contentRevisions: Object.fromEntries(ids('sec-a31', 1, 3).map((id) => [id, 2])),
    })
    const second = await reloadWithoutImport(first)

    await switchLanguage(second.container, 'en')
    await importFiles(second.container, [file(bilingualB)])
    buttonByText(second.container, 'Apply update').click()
    await vi.waitFor(() => expect(second.container.querySelector('.import-report').textContent).toContain('Library updated to version 1.1.0'))
    await settle()

    const after = await session()

    expect(after.orderedQuestionIds).toEqual(before.orderedQuestionIds)
    expect(after.sessionId).toBe(before.sessionId)
    expect(after.skippedQuestionIds).toEqual(before.skippedQuestionIds)
    expect(second.container.querySelector('[aria-label="Learning round"]').textContent).toContain(
      '2 new questions in this section will only join from the next round',
    )
    expect(sectionCard(second.container, 'Learning section 99').textContent).toContain('German · English')

    await resume(second.container)
    expect(scoreText(second.container)).toContain('Question 1 of 4')
  })

  it('progress stays identity-based: one record per (libraryId, question.id) regardless of language and mode', async () => {
    const first = await importAndOpenEnglish([mixed])

    await startQuiz(first.container)

    const id = await answerAny(first.container, [mixed])

    await settle()
    await switchLanguage(first.container, 'de')
    await settle()

    const progress = await withStore((store) => store.listAllProgress())

    expect(progress).toHaveLength(1)
    expect(progress[0]).toMatchObject({ libraryId: 'lib-mix', questionId: id, attempts: 1 })
  })
})
