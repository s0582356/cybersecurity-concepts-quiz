// @vitest-environment jsdom
// Prüfungsmodus-Oberfläche (Phase 3C): Einstieg, Start, aktive Prüfung, Navigation, Abgabe, Ergebnis, Resume.
// Nur synthetische Daten. Die Tests laufen gegen die echte App (Vue + IndexedDB-Fake).
import 'fake-indexeddb/auto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createApp, nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { de } from '../src/i18n/de.js'
import { en } from '../src/i18n/en.js'
import { buildExamView } from '../src/domain/examView.js'
import { createExamAttempt, finalizeExamAttemptRecord } from '../src/domain/examAttempt.js'
import ExamResult from '../src/components/ExamResult.vue'
import { parseV2Library } from '../src/lib/library/parseLibrary.js'
import { createSessionRecord } from '../src/domain/session.js'
import {
  importFiles,
  mountApp,
  resetBrowserStorage,
  settle,
  switchLanguage,
  unmountAll,
  unmountApp,
  withStore,
} from './helpers/appHarness.js'
import { clone, deepFreeze, makeExamLibraryData } from './fixtures/examFixtures.js'

const componentsDir = join(process.cwd(), 'src/components')
const SIZES = { la01: 40, la02: 60, la03: 30 } // 130 Fragen: alle Presets 20 / 45 / 90 sind erfüllbar
const files = (sizes = SIZES, options) => makeExamLibraryData(sizes, options).map((data, index) => ({ name: `lib-${index}.json`, data }))

beforeEach(resetBrowserStorage)
afterEach(() => {
  vi.restoreAllMocks()
  unmountAll()
})

// --- Hilfen --------------------------------------------------------------------------------------------------------

const tile = (container) => container.querySelector('.exam-entry')
const text = (container) => container.textContent.replace(/\s+/g, ' ').trim()
const examButton = (container, name) => container.querySelector(`[data-exam="${name}"]`)
const options = (container) => [...container.querySelectorAll('.exam-option')]
const positionText = (container) => container.querySelector('.exam-position')?.textContent.trim()

async function setup(sizes = SIZES, importOptions) {
  const app = mountApp()

  await importFiles(app.container, files(sizes, importOptions))
  await vi.waitFor(() => expect(tile(app.container)).not.toBeNull())
  await settle(20)

  return app
}

async function openExam({ container }) {
  examButton(container, 'open').click()
  await vi.waitFor(() => expect(container.querySelector('.exam-start, .exam-card, .exam-result, .exam-damaged')).not.toBeNull())
}

async function startExamUi(app, { preset, language } = {}) {
  const { container } = app

  await openExam(app)

  if (language) {
    container.querySelector(`[data-language="${language}"]`).click()
    await settle(10)
  }

  if (preset) {
    container.querySelector(`[data-preset="${preset}"]`).click()
    await settle(10)
  }

  examButton(container, 'start').click()
  await vi.waitFor(() => expect(container.querySelector('.exam-card')).not.toBeNull())
  await settle(20)
}

const storedAttempt = () => withStore((store) => store.getActiveExamAttempt())
const lastAttempt = () => withStore(async (store) => (await store.listExamAttempts())[0])

async function choose(container, index) {
  options(container)[index].click()
  await vi.waitFor(() => expect(options(container)[index].getAttribute('aria-pressed')).toBe('true'))
}

async function step(container, name, expectedPosition) {
  examButton(container, name).click()
  await vi.waitFor(() => expect(positionText(container)).toBe(expectedPosition))
}

async function gotoQuestion(container, number, total) {
  for (let current = Number(positionText(container).match(/\d+/)[0]); current < number; current++) {
    await step(container, 'next', `Frage ${current + 1} von ${total}`)
  }
}

// Alle vom Vue-Baum an Komponenten übergebenen Props (tatsächlicher Komponenten-Input).
function propsOf(entry, componentName) {
  const found = []
  const walk = (vnode) => {
    if (!vnode) {
      return
    }

    if (vnode.component) {
      if (vnode.component.type.__name === componentName) {
        found.push(vnode.component.props)
      }

      walk(vnode.component.subTree)
    }

    if (Array.isArray(vnode.children)) {
      vnode.children.forEach((child) => child && typeof child === 'object' && walk(child))
    }
  }

  walk(entry.app._instance.subTree)

  return found
}

function collectKeys(value, keys = new Set()) {
  if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, inner]) => {
      keys.add(key)
      collectKeys(inner, keys)
    })
  }

  return keys
}

const FORBIDDEN_KEYS = ['correctOptionKey', 'correctAnswer', 'explanation', 'memoryAid', 'questionSnapshots', 'isCorrect', 'correct', 'incorrect']

// --- A–C Einstieg --------------------------------------------------------------------------------------------------

describe('exam entry (Section 28 as a logical UI section)', () => {
  it('A: shows the Exam Mode tile, German and English, outside the learning-section cards', async () => {
    const app = await setup()

    expect(tile(app.container).querySelector('h2').textContent).toBe('Prüfungsmodus')
    expect(tile(app.container).querySelector('.eyebrow').textContent).toBe('Prüfungstraining')
    expect(app.container.querySelectorAll('.section-card')).toHaveLength(3)
    expect(tile(app.container).closest('.section-card')).toBeNull()
    expect(app.container.querySelector('.section-overview').contains(tile(app.container))).toBe(false)

    await switchLanguage(app.container, 'en')

    expect(tile(app.container).querySelector('h2').textContent).toBe('Exam Mode')
    expect(tile(app.container).querySelector('.eyebrow').textContent).toBe('Exam Practice')
    expect(await withStore((store) => store.listLibraryStates())).toHaveLength(3) // keine eigene Library für den Prüfungsmodus
  })

  it('does not claim an official exam: neutral wording only (DE and EN)', async () => {
    const app = await setup()
    const german = text(tile(app.container))

    await switchLanguage(app.container, 'en')

    const english = text(tile(app.container))

    expect(german).toContain('keine offizielle Prüfungssimulation')
    expect(english).toContain('not an official exam simulation')
    expect(`${german} ${english}`).not.toMatch(/echte CompTIA|real CompTIA|CompTIA-Prüfung\b/)
  })

  it('B: without a running exam it offers to start', async () => {
    const app = await setup()

    expect(examButton(app.container, 'open').textContent.trim()).toBe('Prüfungsmodus starten')
    expect(text(tile(app.container))).not.toContain('fortsetzen')
  })

  it('C: with a running exam it offers to resume instead of a second start', async () => {
    const app = await setup()

    await startExamUi(app, { preset: 'short' })
    await choose(app.container, 0)
    examButton(app.container, 'close').click()
    await vi.waitFor(() => expect(tile(app.container)).not.toBeNull())
    await vi.waitFor(() => expect(examButton(app.container, 'open').textContent.trim()).toBe('Laufende Prüfung fortsetzen'))

    expect(text(tile(app.container))).toContain('Frage 1 von 20 · 1 beantwortet')
    expect(text(tile(app.container))).not.toContain('Prüfungsmodus starten')
    expect(await withStore((store) => store.listExamAttempts())).toHaveLength(1)

    await switchLanguage(app.container, 'en')
    expect(examButton(app.container, 'open').textContent.trim()).toBe('Resume exam')
  })

  it('explains an unavailable exam mode when there are too few questions', async () => {
    const app = await setup({ la01: 6 })

    expect(examButton(app.container, 'open')).toBeNull()
    expect(text(tile(app.container))).toContain('mindestens 10 importierte Fragen')
    expect(text(tile(app.container))).toContain('aktuell 6')
  })

  it('shows no exam tile before anything is imported', async () => {
    const app = mountApp()

    await settle(80)
    expect(tile(app.container)).toBeNull()
  })
})

// --- D–J Start -----------------------------------------------------------------------------------------------------

describe('start screen', () => {
  it('shows title, explanation, question counts, language choice and start button; 45 is the default', async () => {
    const app = await setup()

    await openExam(app)

    const { container } = app

    expect(container.querySelector('.exam-start h2').textContent).toBe('Prüfungsmodus')
    expect(text(container.querySelector('.exam-start'))).toContain('Während der Prüfung gibt es keine Rückmeldung')
    expect([...container.querySelectorAll('[data-preset]')].map((button) => button.textContent.trim())).toEqual([
      'Kurz – 20 Fragen',
      'Mittel – 45 Fragen',
      'Lang – 90 Fragen',
    ])
    expect(container.querySelector('[data-preset="medium"]').getAttribute('aria-pressed')).toBe('true')
    expect(container.querySelector('[data-preset="short"]').getAttribute('aria-pressed')).toBe('false')
    expect([...container.querySelectorAll('[data-language]')].map((button) => button.textContent.trim())).toEqual(['Deutsch', 'English'])
    expect(container.querySelector('[data-language="de"]').getAttribute('aria-pressed')).toBe('true')
    expect(text(container)).toContain('In dieser Sprache verfügbar: 130 Fragen')
    expect(examButton(container, 'start').textContent.trim()).toBe('Prüfung starten')
    // kein "allAvailable" / Fallback-Auswahl
    expect(container.querySelectorAll('[data-language]')).toHaveLength(2)
    expect(text(container)).not.toMatch(/Alle verfügbaren|all available/i)
  })

  it('D: preset Kurz starts a 20-question exam', async () => {
    const app = await setup()

    await startExamUi(app, { preset: 'short' })

    const attempt = await storedAttempt()

    expect(attempt).toMatchObject({ questionCount: 20, examPreset: 'short', status: 'inProgress' })
    expect(positionText(app.container)).toBe('Frage 1 von 20')
  })

  it('E: default (Mittel) starts a 45-question exam', async () => {
    const app = await setup()

    await startExamUi(app)

    expect(await storedAttempt()).toMatchObject({ questionCount: 45, examPreset: 'medium' })
    expect(positionText(app.container)).toBe('Frage 1 von 45')
  })

  it('F: preset Lang starts a 90-question exam', async () => {
    const app = await setup()

    await startExamUi(app, { preset: 'long' })

    expect(await storedAttempt()).toMatchObject({ questionCount: 90, examPreset: 'long' })
    expect(positionText(app.container)).toBe('Frage 1 von 90')
  })

  it('G: German exam – German content, fixed language', async () => {
    const app = await setup()

    await startExamUi(app, { preset: 'short', language: 'de' })

    const attempt = await storedAttempt()

    expect(attempt).toMatchObject({ sessionLanguage: 'de', languageMode: null })
    expect(app.container.querySelector('.exam-question-text').textContent).toMatch(/^Frage la0\d \d{4}\?$/)
    expect(text(app.container)).toContain('Prüfungssprache: Deutsch')
  })

  it('H: English exam – English content only, no German fallback', async () => {
    const app = await setup()

    await startExamUi(app, { preset: 'short', language: 'en' })

    const attempt = await storedAttempt()

    expect(attempt).toMatchObject({ sessionLanguage: 'en', languageMode: 'onlyEnglish' })
    expect(app.container.querySelector('.exam-question-text').textContent).toMatch(/^Frage la0\d EN \d{4}\?$/)
    expect(options(app.container).every((button) => /^English \d{4} [A-D]$/.test(button.textContent.trim()))).toBe(true)
    expect(text(app.container)).not.toContain('Synthetisch')
    expect(text(app.container)).toContain('Prüfungssprache: English')
  })

  it('pre-selects the language from the app content language', async () => {
    const app = await setup()

    await switchLanguage(app.container, 'en')
    examButton(app.container, 'open').click()
    await vi.waitFor(() => expect(app.container.querySelector('.exam-start')).not.toBeNull())

    expect(app.container.querySelector('[data-language="en"]').getAttribute('aria-pressed')).toBe('true')
    expect(app.container.querySelector('[data-preset="medium"]').textContent.trim()).toBe('Medium – 45 questions')
  })

  it('I: starting creates exactly one persisted attempt', async () => {
    const app = await setup()

    await startExamUi(app, { preset: 'short' })

    const attempts = await withStore((store) => store.listExamAttempts())

    expect(attempts).toHaveLength(1)
    expect(attempts[0].orderedQuestionIds).toHaveLength(20)
  })

  it('shows the really generated count when the language pool is smaller than the preset (core capping)', async () => {
    const app = await setup({ la01: 12, la02: 18 }) // 30 Fragen

    await openExam(app)

    expect([...app.container.querySelectorAll('[data-preset]')].map((button) => button.textContent.trim())).toEqual([
      'Kurz – 20 Fragen',
      'Mittel – 30 Fragen',
      'Lang – 30 Fragen',
    ])
    expect(text(app.container)).toContain('nur 30 Fragen verfügbar')

    examButton(app.container, 'start').click()
    await vi.waitFor(() => expect(positionText(app.container)).toBe('Frage 1 von 30'))
    expect(await storedAttempt()).toMatchObject({ examPreset: 'medium', questionCount: 30 })
  })

  it('English pool smaller than German pool: counts per language come from the core', async () => {
    const english = Array.from({ length: 15 }, (_, index) => `sec-a01-${String(index + 1).padStart(4, '0')}`)
    const app = await setup({ la01: 30, la02: 30 }, { english })

    await openExam(app)
    app.container.querySelector('[data-language="en"]').click()
    await settle(10)

    expect(text(app.container)).toContain('In dieser Sprache verfügbar: 15 Fragen')
    expect(app.container.querySelector('[data-preset="long"]').textContent.trim()).toBe('Lang – 15 Fragen')

    app.container.querySelector('[data-language="de"]').click()
    await settle(10)
    expect(app.container.querySelector('[data-preset="long"]').textContent.trim()).toBe('Lang – 60 Fragen')
  })

  it('disables starting when a language has too few questions', async () => {
    const english = Array.from({ length: 4 }, (_, index) => `sec-a01-${String(index + 1).padStart(4, '0')}`)
    const app = await setup({ la01: 30 }, { english })

    await openExam(app)
    app.container.querySelector('[data-language="en"]').click()
    await settle(10)

    expect(examButton(app.container, 'start').disabled).toBe(true)
    expect(text(app.container)).toContain('zu wenige Fragen')
  })

  it('the start button creates no second attempt while one is running in another tab (core guard)', async () => {
    const app = await setup()

    await openExam(app)
    await withStore(async (store) => {
      const { startExam } = await import('../src/storage/examService.js')

      await startExam(store, { preset: 'short', language: 'de' })
    })
    examButton(app.container, 'start').click()
    await vi.waitFor(() => expect(app.container.querySelector('.exam-card')).not.toBeNull())

    expect(text(app.container)).toContain('Es läuft bereits eine Prüfung')
    expect(positionText(app.container)).toBe('Frage 1 von 20') // genau der laufende Versuch
    expect(await withStore((store) => store.listExamAttempts())).toHaveLength(1)
  })
})

// --- J–O aktive Frage, kein Feedback-Leak --------------------------------------------------------------------------

describe('active exam question', () => {
  it('J/K: shows the active question with the stored option order from the core', async () => {
    const app = await setup()

    await startExamUi(app, { preset: 'short' })

    const attempt = await storedAttempt()
    const id = attempt.orderedQuestionIds[0]
    const { content } = attempt.questionSnapshots[id]

    expect(app.container.querySelector('.exam-question-text').textContent).toBe(content.question)
    expect(options(app.container).map((button) => button.textContent.trim())).toEqual(
      attempt.optionOrder[id].map((key) => content.optionText[key]),
    )
    expect(options(app.container).map((button) => button.dataset.optionKey)).toEqual(attempt.optionOrder[id])
    expect(app.container.querySelector('h2').textContent).toBe('Prüfungsmodus')
    expect(app.container.querySelector('.exam-question-text').tagName).toBe('H3')
    expect(app.container.querySelector('[role="progressbar"]')).not.toBeNull()
  })

  it('L: marks a choice neutrally (aria-pressed + marker), stores it, and does not evaluate', async () => {
    const app = await setup()

    await startExamUi(app, { preset: 'short' })
    await choose(app.container, 2)

    const attempt = await storedAttempt()
    const id = attempt.orderedQuestionIds[0]
    const selected = options(app.container)[2]

    expect(attempt.answers).toEqual({ [id]: selected.dataset.optionKey })
    expect(selected.classList.contains('answer-selected')).toBe(true)
    expect(app.container.querySelector('.exam-mode').innerHTML).not.toMatch(/answer-(correct|wrong|muted)|feedback/)
    expect([...selected.classList].sort()).toEqual(['answer-button', 'answer-selected', 'exam-option'])
    expect(options(app.container).filter((button) => button !== selected).every((button) => [...button.classList].sort().join() === 'answer-button,exam-option')).toBe(true)
    expect(options(app.container).filter((button) => button.getAttribute('aria-pressed') === 'true')).toHaveLength(1)
    expect(options(app.container).every((button) => !button.disabled)).toBe(true) // änderbar
    expect(text(app.container)).toContain('Eine Antwort ist ausgewählt')
    expect(positionText(app.container)).toBe('Frage 1 von 20') // kein automatischer Wechsel
  })

  it('M/N/O: no correctness feedback, no explanation, no memory aid, no score, no streak while the exam runs', async () => {
    const app = await setup()

    await startExamUi(app, { preset: 'short' })

    for (let index = 0; index < 4; index++) {
      await choose(app.container, index)
      await step(app.container, 'next', `Frage ${index + 2} von 20`)
    }

    const html = app.container.querySelector('.exam-mode').innerHTML

    ;['Richtig', 'Nicht ganz', 'Falsch', 'Synthetische Erklärung', 'Synthetisch.', 'Merkhilfe', 'Serie', 'Punkte', 'Ergebnis'].forEach((word) =>
      expect(html, word).not.toContain(word),
    )
    ;['feedback-box', 'answer-correct', 'answer-wrong', 'answer-muted', 'score-card', 'explanation', 'feedback-correct'].forEach((name) =>
      expect(html, name).not.toContain(name),
    )
    expect(app.container.querySelector('.exam-result')).toBeNull()
  })

  it('EN exam: no explanation / memory aid / correctness either', async () => {
    const app = await setup()

    await startExamUi(app, { preset: 'short', language: 'en' })
    await choose(app.container, 1)

    const html = app.container.querySelector('.exam-mode').innerHTML

    ;['Synthetic explanation', 'Synthetic memory aid', 'Correct', 'Incorrect', 'Not quite', 'explanation', 'feedback'].forEach((word) =>
      expect(html, word).not.toContain(word),
    )
  })

  it('component input never contains solution, explanation, memory aid, result or correctness flags', async () => {
    const app = await setup()

    await startExamUi(app, { preset: 'short' })
    await choose(app.container, 0)
    examButton(app.container, 'submit').click()
    await vi.waitFor(() => expect(app.container.querySelector('.exam-dialog')).not.toBeNull())

    const attempt = await storedAttempt()
    const secrets = Object.values(attempt.questionSnapshots).flatMap(({ content }) => [content.explanation, content.memoryAid.text])
    const passed = ['ExamQuestionView', 'ExamSubmitPanel', 'ExamMode', 'ExamEntryCard'].flatMap((name) => propsOf(app, name))

    expect(propsOf(app, 'ExamQuestionView')).toHaveLength(1)
    expect(propsOf(app, 'ExamSubmitPanel')).toHaveLength(1)
    passed.forEach((props) => {
      const serialized = JSON.stringify(props)

      FORBIDDEN_KEYS.forEach((key) => expect(collectKeys(props).has(key), key).toBe(false))
      secrets.forEach((secret) => expect(serialized).not.toContain(secret))
    })

    const [questionProps] = propsOf(app, 'ExamQuestionView')

    expect(questionProps.view.result).toBeNull()
    expect(Object.keys(questionProps.view.question).sort()).toEqual(['id', 'index', 'options', 'selectedKey', 'text', 'total'])
    // Der Container reicht den gespeicherten Versuch nicht weiter (nur `store`, `defaultLanguage`).
    expect(Object.keys(propsOf(app, 'ExamMode')[0]).sort()).toEqual(['defaultLanguage', 'store'])
  })

  it('the view model builder is a strict allowlist (frozen attempt, tampered result is passed through, not recomputed)', () => {
    const [{ library, questions }] = makeExamLibraryData({ la01: 12 }).map(parseV2Library)
    const pool = questions.map((question) => ({ question, libraryId: library.libraryId, sectionId: library.learningSectionId }))
    const running = createExamAttempt({ pool, libraries: [library], count: 10 })
    const view = buildExamView(deepFreeze(clone(running)))

    expect(Object.keys(view).sort()).toEqual([
      'answeredCount',
      'currentIndex',
      'examSessionId',
      'firstUnansweredIndex',
      'language',
      'question',
      'questionCount',
      'result',
      'status',
      'unansweredCount',
    ])
    expect(view.result).toBeNull()
    FORBIDDEN_KEYS.forEach((key) => expect(collectKeys(view).has(key), key).toBe(false))

    const submitted = clone(finalizeExamAttemptRecord(running, running.sessionStartedAt + 5).attempt)

    submitted.result.percent = 77 // die Anzeige zeigt den gespeicherten Wert, sie rechnet nichts neu
    expect(buildExamView(submitted)).toMatchObject({ question: null, result: { percent: 77, total: 10, unanswered: 10 } })
    expect(Object.keys(buildExamView(submitted).result).sort()).toEqual(['correct', 'incorrect', 'percent', 'total', 'unanswered'])
  })

  it('exam components never touch solutions, scoring or learning-mode handlers (source guard)', () => {
    const names = ['ExamMode', 'ExamEntryCard', 'ExamStart', 'ExamQuestionView', 'ExamSubmitPanel', 'ExamResult']

    names.forEach((name) => {
      const source = readFileSync(join(componentsDir, `${name}.vue`), 'utf8')

      ;['correctOptionKey', 'correctAnswer', 'questionSnapshots', 'explanation', 'memoryAid', 'scoreExamAttempt', 'finalizeExamAttemptRecord', 'recordAnswer', 'recordSessionAnswer', 'startNewSession', 'QuizCard', 'ScoreBox', 'selectAnswer'].forEach(
        (forbidden) => expect(source.includes(forbidden), `${name}: ${forbidden}`).toBe(false),
      )
    })
  })
})

// --- P–U Navigation, Antworten, Zähler -----------------------------------------------------------------------------

describe('navigation and answers', () => {
  it('P/Q/R: Back and Next move through the stored position; bounds are enforced', async () => {
    const app = await setup()

    await startExamUi(app, { preset: 'short' })

    const { container } = app

    expect(examButton(container, 'back').disabled).toBe(true)
    expect(examButton(container, 'next').disabled).toBe(false)

    await step(container, 'next', 'Frage 2 von 20')
    expect((await storedAttempt()).currentIndex).toBe(1)
    expect(examButton(container, 'back').disabled).toBe(false)

    await step(container, 'back', 'Frage 1 von 20')
    expect((await storedAttempt()).currentIndex).toBe(0)

    await gotoQuestion(container, 20, 20)
    expect(examButton(container, 'next').disabled).toBe(true)
    expect((await storedAttempt()).currentIndex).toBe(19)
    expect(examButton(container, 'submit').disabled).toBe(false)
    expect(container.querySelector('.exam-result')).toBeNull() // kein automatisches Abgeben auf der letzten Frage
  })

  it('S: an answer can be changed until submit; the old choice is replaced', async () => {
    const app = await setup()

    await startExamUi(app, { preset: 'short' })
    await choose(app.container, 0)
    await choose(app.container, 3)

    const attempt = await storedAttempt()
    const id = attempt.orderedQuestionIds[0]

    expect(attempt.answers[id]).toBe(options(app.container)[3].dataset.optionKey)
    expect(options(app.container)[0].getAttribute('aria-pressed')).toBe('false')
    expect(Object.keys(attempt.answers)).toHaveLength(1)
  })

  it('selection is shown again when coming back to an answered question', async () => {
    const app = await setup()

    await startExamUi(app, { preset: 'short' })
    await choose(app.container, 1)
    await step(app.container, 'next', 'Frage 2 von 20')

    expect(options(app.container).every((button) => button.getAttribute('aria-pressed') === 'false')).toBe(true)
    expect(text(app.container)).toContain('Noch keine Antwort ausgewählt')

    await step(app.container, 'back', 'Frage 1 von 20')
    expect(options(app.container)[1].getAttribute('aria-pressed')).toBe('true')
  })

  it('T/U: unanswered questions are allowed; answered / unanswered counts are shown (not as a score)', async () => {
    const app = await setup()

    await startExamUi(app, { preset: 'short' })

    expect(text(app.container)).toContain('Beantwortet: 0 / 20')
    expect(text(app.container)).toContain('Unbeantwortet: 20')

    await choose(app.container, 0)
    await step(app.container, 'next', 'Frage 2 von 20')
    await step(app.container, 'next', 'Frage 3 von 20') // Frage 2 bleibt offen
    await choose(app.container, 1)
    await choose(app.container, 2) // Änderung zählt nicht doppelt

    expect(text(app.container)).toContain('Beantwortet: 2 / 20')
    expect(text(app.container)).toContain('Unbeantwortet: 18')
    expect(app.container.querySelector('[role="progressbar"]').getAttribute('aria-valuenow')).toBe('2')
  })

  it('a UI language switch during the exam changes only the interface, not the exam content or language', async () => {
    const app = await setup()

    await startExamUi(app, { preset: 'short', language: 'en' })

    const questionBefore = app.container.querySelector('.exam-question-text').textContent
    const optionsBefore = options(app.container).map((button) => button.textContent)

    await switchLanguage(app.container, 'de')
    await switchLanguage(app.container, 'en')
    await switchLanguage(app.container, 'de')

    expect(positionText(app.container)).toBe('Frage 1 von 20') // Oberfläche folgt der UI-Sprache
    expect(app.container.querySelector('.exam-question-text').textContent).toBe(questionBefore)
    expect(options(app.container).map((button) => button.textContent)).toEqual(optionsBefore)
    expect((await storedAttempt()).sessionLanguage).toBe('en')

    await switchLanguage(app.container, 'en')
    expect(positionText(app.container)).toBe('Question 1 of 20')
    expect(examButton(app.container, 'submit').textContent.trim()).toBe('Submit exam')
    expect(examButton(app.container, 'back').textContent.trim()).toBe('Back')
    expect(examButton(app.container, 'next').textContent.trim()).toBe('Next')
  })
})

// --- V–AB Abgabe ---------------------------------------------------------------------------------------------------

describe('submit', () => {
  async function answeredExam(app, answers) {
    await startExamUi(app, { preset: 'short' })

    for (const [index, optionIndex] of answers.entries()) {
      if (optionIndex !== null) {
        await choose(app.container, optionIndex)
      }

      if (index < 19) {
        await step(app.container, 'next', `Frage ${index + 2} von 20`)
      }
    }
  }

  const openDialog = async (app) => {
    examButton(app.container, 'submit').click()
    await vi.waitFor(() => expect(app.container.querySelector('.exam-dialog')).not.toBeNull())
    await settle(10)
  }

  it('V/W: asks for confirmation and warns about unanswered questions (with the exact number)', async () => {
    const app = await setup()

    await answeredExam(app, [0, 1, 2, null, null, ...Array(15).fill(null)].slice(0, 20))

    await openDialog(app)

    expect(app.container.querySelector('.exam-dialog h3').textContent).toBe('Prüfung abgeben?')
    expect(text(app.container.querySelector('.exam-dialog'))).toContain('17 Fragen sind noch unbeantwortet')
    expect(app.container.querySelector('.exam-dialog [role="alert"]')).not.toBeNull()
    expect((await storedAttempt()).status).toBe('inProgress') // noch nichts abgegeben
    expect(document.activeElement).toBe(app.container.querySelector('.exam-dialog'))
  })

  it('singular wording for one open question; clear confirmation when everything is answered', async () => {
    const app = await setup()

    await answeredExam(app, [...Array(19).fill(0), null])
    await openDialog(app)
    expect(text(app.container.querySelector('.exam-dialog'))).toContain('1 Frage ist noch unbeantwortet')

    app.container.querySelector('[data-exam="cancel"]').click()
    await vi.waitFor(() => expect(app.container.querySelector('.exam-dialog')).toBeNull())
    await choose(app.container, 0)
    await openDialog(app)
    expect(text(app.container.querySelector('.exam-dialog'))).toContain('Alle 20 Fragen sind beantwortet')
    expect(app.container.querySelector('.exam-dialog [role="alert"]')).toBeNull()
  })

  it('X: cancel (button and Escape) keeps the exam active and unchanged', async () => {
    const app = await setup()

    await answeredExam(app, [0, 1])
    const before = await storedAttempt()

    await openDialog(app)
    app.container.querySelector('[data-exam="cancel"]').click()
    await vi.waitFor(() => expect(app.container.querySelector('.exam-dialog')).toBeNull())
    expect(await storedAttempt()).toEqual(before)
    expect(app.container.querySelector('.exam-result')).toBeNull()
    expect(options(app.container).length).toBe(4)

    await openDialog(app)
    app.container.querySelector('.exam-dialog').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await vi.waitFor(() => expect(app.container.querySelector('.exam-dialog')).toBeNull())
    expect(await storedAttempt()).toEqual(before)
  })

  it('"go to first unanswered question" jumps there and closes the dialog', async () => {
    const app = await setup()

    await answeredExam(app, [0, 1, null, 2])
    await openDialog(app)
    app.container.querySelector('[data-exam="goto-first"]').click()
    await vi.waitFor(() => expect(positionText(app.container)).toBe('Frage 3 von 20'))

    expect(app.container.querySelector('.exam-dialog')).toBeNull()
    expect((await storedAttempt()).currentIndex).toBe(2)
  })

  it('Y/AA: confirm submits; the summary is exactly the stored attempt.result', async () => {
    const app = await setup()

    await answeredExam(app, [0, 1, 2, 3, 0, 1, ...Array(14).fill(null)])

    const running = await storedAttempt()
    const keys = Object.fromEntries(running.orderedQuestionIds.map((id) => [id, running.questionSnapshots[id].correctOptionKey]))

    await openDialog(app)
    app.container.querySelector('[data-exam="confirm"]').click()
    await vi.waitFor(() => expect(app.container.querySelector('.exam-result')).not.toBeNull())

    const done = await lastAttempt()
    const shown = (name) => app.container.querySelector(`[data-result="${name}"]`).textContent.trim()

    expect(done.status).toBe('submitted')
    expect(done.result).toMatchObject({ total: 20 })
    expect(shown('total')).toBe(String(done.result.total))
    expect(shown('correct')).toBe(String(done.result.correct))
    expect(shown('incorrect')).toBe(String(done.result.incorrect))
    expect(shown('unanswered')).toBe('14')
    expect(shown('percent')).toBe(`${done.result.percent} %`)
    // unabhängige Nachrechnung nur im Test (aus gespeicherten Antworten + Lösungsschlüsseln)
    const correct = Object.entries(done.answers).filter(([id, key]) => keys[id] === key).length

    expect(done.result.correct).toBe(correct)
    expect(done.result.incorrect).toBe(6 - correct)
    expect(app.container.querySelector('h2').textContent).toBe('Prüfung abgeschlossen')
    expect(text(app.container)).toContain('keine offizielle Wertung')
    expect(options(app.container)).toHaveLength(0)
    expect(app.container.querySelector('.exam-dialog')).toBeNull()
    expect(app.container.querySelector('.feedback-box, .answer-correct, .answer-wrong')).toBeNull() // kein Question-by-Question-Review
  })

  it('Z: a double click on "Submit now" finalizes once', async () => {
    const app = await setup()

    await answeredExam(app, [0, 1])
    await openDialog(app)

    const original = IDBDatabase.prototype.transaction
    const writes = []

    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (names, mode) {
      if (mode === 'readwrite') {
        writes.push([names].flat().join(','))
      }

      return original.call(this, names, mode)
    })

    const confirm = app.container.querySelector('[data-exam="confirm"]')

    confirm.click()
    confirm.click()
    confirm.click()
    await vi.waitFor(() => expect(app.container.querySelector('.exam-result')).not.toBeNull())

    expect(writes).toEqual(['examAttempts']) // genau ein Schreibzugriff, nur auf den Exam-Store
    expect(await withStore((store) => store.listExamAttempts())).toHaveLength(1)
  })

  it('submit buttons are disabled and relabelled while submitting', async () => {
    const app = await setup()

    await answeredExam(app, [0])
    await openDialog(app)
    app.container.querySelector('[data-exam="confirm"]').click()
    await nextTick() // gerendert, bevor die (asynchrone) Speicherantwort eintrifft

    const buttons = [...app.container.querySelectorAll('.exam-dialog button')]

    expect(buttons.every((button) => button.disabled)).toBe(true)
    expect(app.container.querySelector('[data-exam="confirm"]').textContent.trim()).toBe('Wird abgegeben …')
    expect(examButton(app.container, 'submit').disabled).toBe(true)
    await vi.waitFor(() => expect(app.container.querySelector('.exam-result')).not.toBeNull())
  })

  it('a failing submit is reported, the exam stays active with its answers, and a retry succeeds', async () => {
    const app = await setup()

    await answeredExam(app, [0, 1])
    await openDialog(app)

    const original = IDBDatabase.prototype.transaction
    let failures = 1

    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (names, mode) {
      if (mode === 'readwrite' && failures-- > 0) {
        throw new Error('simulierter Schreibfehler')
      }

      return original.call(this, names, mode)
    })

    app.container.querySelector('[data-exam="confirm"]').click()
    await vi.waitFor(() => expect(app.container.querySelector('.library-message-error')).not.toBeNull())

    expect(app.container.querySelector('.library-message-error').textContent).toContain('konnte nicht abgegeben werden')
    expect(app.container.querySelector('.library-message-error').textContent).toContain('simulierter Schreibfehler')
    expect(app.container.querySelector('.exam-result')).toBeNull()
    expect(app.container.querySelector('.exam-dialog')).not.toBeNull()
    expect(app.container.querySelector('[data-exam="confirm"]').disabled).toBe(false)

    const stored = await storedAttempt()

    expect(stored.status).toBe('inProgress')
    expect(Object.keys(stored.answers)).toHaveLength(2)

    app.container.querySelector('[data-exam="confirm"]').click()
    await vi.waitFor(() => expect(app.container.querySelector('.exam-result')).not.toBeNull())
    expect(app.container.querySelector('.library-message-error')).toBeNull()
  })

  it('a failing answer write is reported and is not shown as selected', async () => {
    const app = await setup()

    await startExamUi(app, { preset: 'short' })

    const original = IDBDatabase.prototype.transaction
    let failures = 1

    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (names, mode) {
      if (mode === 'readwrite' && failures-- > 0) {
        throw new Error('simulierter Schreibfehler')
      }

      return original.call(this, names, mode)
    })

    options(app.container)[0].click()
    await vi.waitFor(() => expect(app.container.querySelector('.library-message-error')).not.toBeNull())

    expect(app.container.querySelector('.library-message-error').textContent).toContain('Antwort konnte nicht gespeichert werden')
    expect(options(app.container)[0].getAttribute('aria-pressed')).toBe('false')
    expect((await storedAttempt()).answers).toEqual({})
  })

  it('AB: a completed exam cannot be edited, the old attempt is never offered as running, and a new exam can start', async () => {
    const app = await setup()

    await answeredExam(app, [0])
    await openDialog(app)
    app.container.querySelector('[data-exam="confirm"]').click()
    await vi.waitFor(() => expect(app.container.querySelector('.exam-result')).not.toBeNull())

    const done = await lastAttempt()

    expect(options(app.container)).toHaveLength(0)
    expect(examButton(app.container, 'next')).toBeNull()
    await withStore(async (store) => {
      const id = done.orderedQuestionIds[1]

      expect(await store.recordExamAnswer({ examSessionId: done.examSessionId, questionId: id, selectedOptionKey: 'a' })).toMatchObject({ recorded: false, reason: 'submitted' })
    })
    expect(await lastAttempt()).toEqual(done)
    expect(await storedAttempt()).toBeNull()

    // Neue Prüfung aus dem Ergebnis heraus
    examButton(app.container, 'new').click()
    await vi.waitFor(() => expect(app.container.querySelector('.exam-start')).not.toBeNull())
    examButton(app.container, 'start').click()
    await vi.waitFor(() => expect(app.container.querySelector('.exam-card')).not.toBeNull())

    const all = await withStore((store) => store.listExamAttempts())

    expect(all).toHaveLength(2)
    expect(all.filter((attempt) => attempt.status === 'inProgress')).toHaveLength(1)
    expect(all.find((attempt) => attempt.examSessionId === done.examSessionId)).toEqual(done)
  })

  it('after submit and reload the exam is not running again; the tile offers a new start', async () => {
    const app = await setup()

    await answeredExam(app, [0])
    await openDialog(app)
    app.container.querySelector('[data-exam="confirm"]').click()
    await vi.waitFor(() => expect(app.container.querySelector('.exam-result')).not.toBeNull())
    unmountApp(app)

    const fresh = mountApp()

    await vi.waitFor(() => expect(tile(fresh.container)).not.toBeNull())
    await vi.waitFor(() => expect(examButton(fresh.container, 'open')).not.toBeNull())
    expect(examButton(fresh.container, 'open').textContent.trim()).toBe('Prüfungsmodus starten')
    expect(await storedAttempt()).toBeNull()
  })
})

// --- AC/AD Resume --------------------------------------------------------------------------------------------------

describe('resume through the UI', () => {
  it('AC: after a reload the exam continues exactly: id, question, index, order, option order, answers, language', async () => {
    const app = await setup()

    await startExamUi(app, { preset: 'short', language: 'en' })
    await choose(app.container, 1)
    await step(app.container, 'next', 'Frage 2 von 20')
    await choose(app.container, 3)
    await step(app.container, 'next', 'Frage 3 von 20')
    await step(app.container, 'back', 'Frage 2 von 20')

    const before = await storedAttempt()
    const shownQuestion = app.container.querySelector('.exam-question-text').textContent
    const shownOptions = options(app.container).map((button) => button.textContent)

    unmountApp(app)

    const fresh = mountApp()

    await vi.waitFor(() => expect(examButton(fresh.container, 'open')).not.toBeNull())
    expect(examButton(fresh.container, 'open').textContent.trim()).toBe('Laufende Prüfung fortsetzen')
    expect(text(tile(fresh.container))).toContain('Frage 2 von 20 · 2 beantwortet')
    await openExam(fresh)

    expect(await storedAttempt()).toEqual(before) // nichts neu gemischt oder berechnet
    expect(positionText(fresh.container)).toBe('Frage 2 von 20')
    expect(fresh.container.querySelector('.exam-question-text').textContent).toBe(shownQuestion)
    expect(options(fresh.container).map((button) => button.textContent)).toEqual(shownOptions)
    expect(options(fresh.container)[3].getAttribute('aria-pressed')).toBe('true')
    expect(text(fresh.container)).toContain('Prüfungssprache: English')
    expect(await withStore((store) => store.listExamAttempts())).toHaveLength(1)
  })

  it('AD: the exam language survives a reload even if the app language is different', async () => {
    const app = await setup()

    await startExamUi(app, { preset: 'short', language: 'en' })
    await switchLanguage(app.container, 'de')
    unmountApp(app)

    const fresh = mountApp()

    await vi.waitFor(() => expect(examButton(fresh.container, 'open')).not.toBeNull())
    await openExam(fresh)

    expect(fresh.container.querySelector('.exam-question-text').textContent).toMatch(/ EN \d{4}\?$/)
    expect(positionText(fresh.container)).toBe('Frage 1 von 20')
    expect((await storedAttempt()).sessionLanguage).toBe('en')
  })

  it('going back to the overview keeps the attempt; re-entering resumes it', async () => {
    const app = await setup()

    await startExamUi(app, { preset: 'short' })

    const before = await storedAttempt()

    examButton(app.container, 'close').click()
    await vi.waitFor(() => expect(tile(app.container)).not.toBeNull())
    await vi.waitFor(() => expect(examButton(app.container, 'open').textContent.trim()).toBe('Laufende Prüfung fortsetzen'))
    expect(await storedAttempt()).toEqual(before)

    await openExam(app)
    expect(positionText(app.container)).toBe('Frage 1 von 20')
    expect(await withStore((store) => store.listExamAttempts())).toHaveLength(1)
  })

  it('a damaged running exam is not resumed; it can only be discarded, after which a new one can start', async () => {
    const app = await setup()

    await startExamUi(app, { preset: 'short' })

    const damaged = { ...(await storedAttempt()), currentIndex: 99 }

    await new Promise((resolve, reject) => {
      const request = indexedDB.open('cybersecurity-concepts-quiz')

      request.onsuccess = () => {
        const database = request.result
        const transaction = database.transaction('examAttempts', 'readwrite')

        transaction.objectStore('examAttempts').put(damaged)
        transaction.oncomplete = () => {
          database.close()
          resolve()
        }
        transaction.onerror = () => reject(transaction.error)
      }
    })
    unmountApp(app)

    const fresh = mountApp()

    await vi.waitFor(() => expect(examButton(fresh.container, 'open')).not.toBeNull())
    expect(text(tile(fresh.container))).toContain('beschädigt')
    await openExam(fresh)
    expect(fresh.container.querySelector('.exam-damaged')).not.toBeNull()
    expect(options(fresh.container)).toHaveLength(0)
    expect(examButton(fresh.container, 'start')).toBeNull()

    examButton(fresh.container, 'discard').click()
    await vi.waitFor(() => expect(fresh.container.querySelector('.exam-start')).not.toBeNull())
    expect(await storedAttempt()).toBeNull()
  })
})

// --- Zwei Tabs (jsdom: zwei App-Instanzen, zwei DB-Verbindungen) ----------------------------------------------------

describe('two app instances on the same database', () => {
  it('start in tab A, start in tab B: one running attempt, tab B continues the same one', async () => {
    const tabA = await setup()
    const tabB = mountApp()

    await vi.waitFor(() => expect(tile(tabB.container)).not.toBeNull())
    await openExam(tabA)
    await openExam(tabB)

    examButton(tabA.container, 'start').click()
    examButton(tabB.container, 'start').click()
    await vi.waitFor(() => expect(tabA.container.querySelector('.exam-card')).not.toBeNull())
    await vi.waitFor(() => expect(tabB.container.querySelector('.exam-card')).not.toBeNull())

    const all = await withStore((store) => store.listExamAttempts())

    expect(all).toHaveLength(1)
    expect(all[0].status).toBe('inProgress')
    expect(positionText(tabA.container)).toBe(positionText(tabB.container))
  })

  it('tab B submits; tab A then answers: the answer is rejected and the result of the stored attempt is shown', async () => {
    const tabA = await setup()

    await startExamUi(tabA, { preset: 'short' })
    await choose(tabA.container, 0)

    const tabB = mountApp()

    await vi.waitFor(() => expect(examButton(tabB.container, 'open')).not.toBeNull())
    await openExam(tabB)
    examButton(tabB.container, 'submit').click()
    await vi.waitFor(() => expect(tabB.container.querySelector('.exam-dialog')).not.toBeNull())
    tabB.container.querySelector('[data-exam="confirm"]').click()
    await vi.waitFor(() => expect(tabB.container.querySelector('.exam-result')).not.toBeNull())

    const done = await lastAttempt()

    options(tabA.container)[2].click()
    await vi.waitFor(() => expect(tabA.container.querySelector('.exam-result')).not.toBeNull())

    expect(text(tabA.container)).toContain('bereits abgegeben')
    expect(await lastAttempt()).toEqual(done)
    expect(Object.keys(done.answers)).toHaveLength(1)
  })
})

// --- AE/AF Isolation -----------------------------------------------------------------------------------------------

describe('isolation from learning data', () => {
  it('AE/AF: a complete exam run writes no progress and touches no learning session', async () => {
    const app = await setup()
    const { library, questions } = parseV2Library(makeExamLibraryData(SIZES)[0])

    await withStore(async (store) => {
      await store.startNewSession(
        createSessionRecord({ sessionId: 'learn-1', library, orderedQuestionIds: questions.map((question) => question.id), optionOrder: ['a', 'b', 'c', 'd'], now: 500 }),
      )
      await store.recordSessionAnswer({ sessionId: 'learn-1', libraryId: library.libraryId, questionId: questions[0].id, isCorrect: true, selectedOptionKey: 'a', answeredAt: 600 })
    })

    const snapshot = () =>
      withStore(async (store) => ({
        progress: await store.listAllProgress(),
        sections: await store.listSectionSessions(),
        session: await store.getLatestSession(library.libraryId),
        states: await store.listLibraryStates(),
        contents: await Promise.all((await store.listLibraryStates()).map((state) => store.getLibraryContent(state.libraryId))),
      }))
    const before = await snapshot()

    await startExamUi(app, { preset: 'short' })

    for (let index = 0; index < 20; index++) {
      await choose(app.container, index % 4)

      if (index < 19) {
        await step(app.container, 'next', `Frage ${index + 2} von 20`)
      }
    }

    await step(app.container, 'back', 'Frage 19 von 20')
    examButton(app.container, 'submit').click()
    await vi.waitFor(() => expect(app.container.querySelector('.exam-dialog')).not.toBeNull())
    app.container.querySelector('[data-exam="confirm"]').click()
    await vi.waitFor(() => expect(app.container.querySelector('.exam-result')).not.toBeNull())

    expect(await snapshot()).toEqual(before)
    expect(app.container.querySelector('.score-card')).toBeNull()
  })

  it('every exam UI write opens only the examAttempts store', async () => {
    const app = await setup()
    const original = IDBDatabase.prototype.transaction
    const opened = []

    await openExam(app)
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (names, mode) {
      opened.push({ names: [names].flat().join(','), mode })

      return original.call(this, names, mode)
    })
    examButton(app.container, 'start').click()
    await vi.waitFor(() => expect(app.container.querySelector('.exam-card')).not.toBeNull())
    await choose(app.container, 0)
    await step(app.container, 'next', 'Frage 2 von 45')

    const writes = opened.filter((entry) => entry.mode === 'readwrite')

    expect(writes.length).toBeGreaterThanOrEqual(3)
    expect(new Set(writes.map((entry) => entry.names))).toEqual(new Set(['examAttempts']))
  })
})

// --- AG i18n -------------------------------------------------------------------------------------------------------

describe('i18n', () => {
  const componentNames = ['ExamMode', 'ExamEntryCard', 'ExamStart', 'ExamQuestionView', 'ExamSubmitPanel', 'ExamResult']

  it('AG: no hard-coded visible text in the exam components (all texts come from the i18n tables)', () => {
    componentNames.forEach((name) => {
      const source = readFileSync(join(componentsDir, `${name}.vue`), 'utf8')
      const template = source.slice(source.indexOf('<template>'))
      const withoutExpressions = template.replace(/\{\{[\s\S]*?\}\}/g, '')
      const textNodes = withoutExpressions.replace(/<\/?[A-Za-z][\w.-]*(?:[^>"']|"[^"]*"|'[^']*')*>/g, '\u0000').split('\u0000').map((part) => part.trim()).filter(Boolean)
      const literalAttributes = [...template.matchAll(/\s(?:aria-label|title|placeholder|alt)="([^"]+)"/g)].map((match) => match[1])

      expect(textNodes, `${name}: Textknoten`).toEqual([])
      expect(literalAttributes, `${name}: Attribute`).toEqual([])
    })
  })

  it('every exam text exists in German and English with matching placeholders; English differs from German', () => {
    const keys = Object.keys(de).filter((key) => key.startsWith('exam.'))
    const same = ['exam.language.de', 'exam.language.en']

    expect(keys.length).toBeGreaterThan(60)
    keys.forEach((key) => {
      expect(en[key], key).toBeTypeOf('string')
      expect([...de[key].matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort(), key).toEqual(
        [...en[key].matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort(),
      )

      if (!same.includes(key)) {
        expect(en[key], key).not.toBe(de[key])
      }
    })
    // alle im Code verwendeten exam.*-Schlüssel sind definiert
    const used = new Set()

    readdirSync(componentsDir)
      .filter((file) => file.startsWith('Exam'))
      .forEach((file) => {
        const source = readFileSync(join(componentsDir, file), 'utf8')

        ;[...source.matchAll(/'(exam\.[\w.]+)'/g)].forEach((match) => used.add(match[1]))
      })
    used.forEach((key) => expect(de[key], key).toBeTypeOf('string'))
  })

  it('the whole flow reads English with the English interface', async () => {
    const app = await setup()

    await switchLanguage(app.container, 'en')
    expect(examButton(app.container, 'open').textContent.trim()).toBe('Start exam mode')
    await openExam(app)
    expect([...app.container.querySelectorAll('[data-preset]')].map((button) => button.textContent.trim())).toEqual([
      'Short – 20 questions',
      'Medium – 45 questions',
      'Long – 90 questions',
    ])
    expect(examButton(app.container, 'start').textContent.trim()).toBe('Start exam')
    app.container.querySelector('[data-preset="short"]').click()
    await settle(10)
    examButton(app.container, 'start').click()
    await vi.waitFor(() => expect(app.container.querySelector('.exam-card')).not.toBeNull())
    expect(positionText(app.container)).toBe('Question 1 of 20')
    expect(text(app.container)).toContain('Answered: 0 / 20')
    expect(text(app.container)).toContain('Unanswered: 20')
    examButton(app.container, 'submit').click()
    await vi.waitFor(() => expect(app.container.querySelector('.exam-dialog')).not.toBeNull())
    expect(text(app.container.querySelector('.exam-dialog'))).toContain('20 questions are still unanswered')
    app.container.querySelector('[data-exam="confirm"]').click()
    await vi.waitFor(() => expect(app.container.querySelector('.exam-result')).not.toBeNull())
    expect(app.container.querySelector('h2').textContent).toBe('Exam completed')
    expect(text(app.container)).toContain('Correct')
    expect(text(app.container)).toContain('Incorrect')
    expect(text(app.container)).toContain('Percent')
  })
})

// --- Phase-3C-Narrow-Fix (Codex-Review P3C-RT-001 … RT-003) -----------------------------------------------------------

describe('P3C-RT-001: header names the real source of the exam questions', () => {
  const label = (container) => container.querySelector('.question-bank-label').textContent.trim()
  const intro = (container) => container.querySelector('.intro').textContent.trim()

  it('shows no "public sample questions" label or intro in exam mode (start, active, result), in DE and EN, and restores the normal header afterwards', async () => {
    const app = await setup()
    const normalLabel = label(app.container)

    await openExam(app)
    expect(label(app.container)).toBe('Prüfungsmodus · Fragen aus deinen importierten Libraries')
    expect(intro(app.container)).toBe('Prüfungstraining mit den lokal importierten Fragen aller Lernabschnitte.')

    examButton(app.container, 'start').click()
    await vi.waitFor(() => expect(app.container.querySelector('.exam-card')).not.toBeNull())
    expect(label(app.container)).not.toMatch(/Beispiel/)
    expect(intro(app.container)).not.toMatch(/Beispiel/)

    await switchLanguage(app.container, 'en')
    expect(label(app.container)).toBe('Exam mode · questions from your imported libraries')
    expect(`${label(app.container)} ${intro(app.container)}`).not.toMatch(/sample|public/i)

    examButton(app.container, 'submit').click()
    await vi.waitFor(() => expect(app.container.querySelector('.exam-dialog')).not.toBeNull())
    app.container.querySelector('[data-exam="confirm"]').click()
    await vi.waitFor(() => expect(app.container.querySelector('.exam-result')).not.toBeNull())
    expect(label(app.container)).not.toMatch(/sample|public|Beispiel/i)

    examButton(app.container, 'close').click()
    await vi.waitFor(() => expect(app.container.querySelector('.exam-result')).toBeNull())
    await switchLanguage(app.container, 'de')
    expect(label(app.container)).toBe(normalLabel)
    expect(label(app.container)).not.toContain('Prüfungsmodus')
  })
})

describe('P3C-RT-002: submit dialog is a focus-safe modal', () => {
  async function runningExam() {
    const app = await setup()

    await startExamUi(app, { preset: 'short' })
    await choose(app.container, 0)
    await step(app.container, 'next', 'Frage 2 von 20')

    return app
  }

  // Tastaturnutzer: der Auslöser hat Fokus, wenn der Dialog geöffnet wird.
  async function openDialogFromKeyboard(app) {
    const trigger = examButton(app.container, 'submit')

    trigger.focus()
    trigger.click()
    await vi.waitFor(() => expect(app.container.querySelector('.exam-dialog')).not.toBeNull())
    await settle(10)

    return trigger
  }

  const key = (target, init) => {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })

    target.dispatchEvent(event)

    return event
  }

  it('declares aria-modal and disables every background control while open (options, back, next, submit)', async () => {
    const app = await runningExam()

    await openDialogFromKeyboard(app)

    expect(app.container.querySelector('.exam-dialog').getAttribute('aria-modal')).toBe('true')
    expect(options(app.container).length).toBe(4)
    expect(options(app.container).every((button) => button.disabled)).toBe(true)
    ;['back', 'next', 'submit'].forEach((name) => expect(examButton(app.container, name).disabled, name).toBe(true))
    expect(await storedAttempt()).toMatchObject({ currentIndex: 1 }) // Hintergrund bleibt unverändert
  })

  it('keeps Tab and Shift+Tab inside the dialog', async () => {
    const app = await runningExam()

    await openDialogFromKeyboard(app)

    const dialog = app.container.querySelector('.exam-dialog')
    const controls = [...dialog.querySelectorAll('button:not(:disabled)')]
    const first = controls[0]
    const last = controls[controls.length - 1]

    expect(controls.length).toBe(3)

    last.focus()
    expect(key(last, { key: 'Tab' }).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(first)

    expect(key(first, { key: 'Tab', shiftKey: true }).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(last)

    // Fokus noch auf dem Dialog selbst: Tab führt zum ersten, Shift+Tab zum letzten Control.
    dialog.focus()
    key(dialog, { key: 'Tab' })
    expect(document.activeElement).toBe(first)
    dialog.focus()
    key(dialog, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)

    // Dazwischen darf Tab nicht blockiert werden.
    first.focus()
    expect(key(first, { key: 'Tab' }).defaultPrevented).toBe(false)
  })

  it('returns focus to the submit button after Cancel, Escape and "go to first unanswered"', async () => {
    const app = await runningExam()

    for (const close of [
      () => app.container.querySelector('[data-exam="cancel"]').click(),
      () => key(app.container.querySelector('.exam-dialog'), { key: 'Escape' }),
      () => app.container.querySelector('[data-exam="goto-first"]').click(),
    ]) {
      const trigger = await openDialogFromKeyboard(app)

      expect(document.activeElement).toBe(app.container.querySelector('.exam-dialog'))
      close()
      await vi.waitFor(() => expect(app.container.querySelector('.exam-dialog')).toBeNull())
      await settle(10)

      expect(document.activeElement).toBe(trigger)
      expect(document.activeElement).not.toBe(document.body)
      expect(trigger.disabled).toBe(false)
      expect(options(app.container).every((button) => !button.disabled)).toBe(true) // Hintergrund wieder bedienbar
    }
  })

  it('disables the outer "back to overview" button while submitting', async () => {
    const app = await runningExam()

    await openDialogFromKeyboard(app)
    app.container.querySelector('[data-exam="confirm"]').click()
    await nextTick()

    expect(examButton(app.container, 'close').disabled).toBe(true)
    await vi.waitFor(() => expect(app.container.querySelector('.exam-result')).not.toBeNull())
    expect(examButton(app.container, 'close').disabled).toBe(false)
  })

  it('moves focus to the result heading after a successful submit', async () => {
    const app = await runningExam()

    await openDialogFromKeyboard(app)
    app.container.querySelector('[data-exam="confirm"]').click()
    await vi.waitFor(() => expect(app.container.querySelector('.exam-result')).not.toBeNull())
    await settle(10)

    expect(document.activeElement).toBe(app.container.querySelector('.exam-result h2'))
    expect(document.activeElement.textContent).toBe('Prüfung abgeschlossen')
  })

  it('a failed submit keeps the dialog open with focus inside and the background disabled', async () => {
    const app = await runningExam()

    await openDialogFromKeyboard(app)

    const original = IDBDatabase.prototype.transaction
    let failures = 1

    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (names, mode) {
      if (mode === 'readwrite' && failures-- > 0) {
        throw new Error('simulierter Schreibfehler')
      }

      return original.call(this, names, mode)
    })
    app.container.querySelector('[data-exam="confirm"]').click()
    await vi.waitFor(() => expect(app.container.querySelector('.library-message-error')).not.toBeNull())

    expect(app.container.querySelector('.exam-dialog')).not.toBeNull()
    expect(options(app.container).every((button) => button.disabled)).toBe(true)
    expect(examButton(app.container, 'close').disabled).toBe(false)
  })
})

describe('P3C-RT-003: the result view shows exactly the stored result values', () => {
  function mountResult(result, language = 'de') {
    const container = document.createElement('div')

    document.body.appendChild(container)

    const app = createApp(ExamResult, { result, language })

    app.mount(container)

    return { container, unmount: () => (app.unmount(), container.remove()) }
  }

  it('renders an intentionally inconsistent result unchanged: no value is recomputed by the component', async () => {
    // total 10 / correct 1 würde rechnerisch 10 % ergeben und 1 + 3 + 6 = 10; gespeichert ist bewusst 77 %.
    const { container, unmount } = mountResult({ total: 10, correct: 1, incorrect: 3, unanswered: 6, percent: 77 })
    const shown = (name) => container.querySelector(`[data-result="${name}"]`).textContent.trim()

    expect(shown('percent')).toBe('77 %')
    expect(shown('total')).toBe('10')
    expect(shown('correct')).toBe('1')
    expect(shown('incorrect')).toBe('3')
    expect(shown('unanswered')).toBe('6')
    unmount()
  })

  it('shows every field independently (all five values different and not derivable from each other)', () => {
    const { container, unmount } = mountResult({ total: 41, correct: 7, incorrect: 11, unanswered: 5, percent: 93 })
    const shown = (name) => container.querySelector(`[data-result="${name}"]`).textContent.trim()

    expect(['total', 'correct', 'incorrect', 'unanswered', 'percent'].map(shown)).toEqual(['41', '7', '11', '5', '93 %'])
    unmount()
  })
})
