// @vitest-environment jsdom
// Prüfungsmodus Phase 3D: Ergebnis-Review, letztes Ergebnis, Verwerfen einer laufenden Prüfung, Randfälle.
// Nur synthetische Daten. Die Tests laufen gegen die echte App (Vue + IndexedDB-Fake).
import 'fake-indexeddb/auto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { de } from '../src/i18n/de.js'
import { en } from '../src/i18n/en.js'
import { parseV2Library } from '../src/lib/library/parseLibrary.js'
import { createSessionRecord } from '../src/domain/session.js'
import { applyLibraryUpdate } from '../src/storage/libraryImport.js'
import { startExam } from '../src/storage/examService.js'
import { importFiles, mountApp, resetBrowserStorage, settle, switchLanguage, unmountAll, unmountApp, withStore } from './helpers/appHarness.js'
import { clone, makeExamLibraryData, seededRandom } from './fixtures/examFixtures.js'

const componentsDir = join(process.cwd(), 'src/components')
const SIZES = { la01: 40, la02: 60, la03: 30 }
const TOTAL = 20 // Preset "short"
const DB_NAME = 'cybersecurity-concepts-quiz'

beforeEach(resetBrowserStorage)
afterEach(() => {
  vi.restoreAllMocks()
  unmountAll()
})

// --- Hilfen --------------------------------------------------------------------------------------------------------

const tile = (container) => container.querySelector('.exam-entry')
const examButton = (container, name) => container.querySelector(`[data-exam="${name}"]`)
const text = (container) => container.textContent.replace(/\s+/g, ' ').trim()
const options = (container) => [...container.querySelectorAll('.exam-option')]

async function setup() {
  const app = mountApp()

  await importFiles(app.container, makeExamLibraryData(SIZES).map((data, index) => ({ name: `lib-${index}.json`, data })))
  await vi.waitFor(() => expect(tile(app.container)).not.toBeNull())
  await settle(20)

  return app
}

// Neu laden = App aushängen und neu mounten (die Datenbank bleibt).
async function remount(app) {
  if (app) {
    unmountApp(app)
  }

  const next = mountApp()

  await vi.waitFor(() => expect(tile(next.container)).not.toBeNull())
  await settle(20)

  return next
}

async function openExam({ container }) {
  examButton(container, 'open').click()
  await vi.waitFor(() => expect(container.querySelector('.exam-start, .exam-card, .exam-result, .exam-damaged')).not.toBeNull())
}

async function startUi(app, { preset = 'short', language } = {}) {
  await openExam(app)

  if (language) {
    app.container.querySelector(`[data-language="${language}"]`).click()
    await settle(10)
  }

  app.container.querySelector(`[data-preset="${preset}"]`).click()
  await settle(10)
  examButton(app.container, 'start').click()
  await vi.waitFor(() => expect(app.container.querySelector('.exam-card')).not.toBeNull())
  await settle(20)
}

const correctKey = (attempt, id) => attempt.questionSnapshots[id].correctOptionKey
const wrongKey = (attempt, id) => ['a', 'b', 'c', 'd'].find((key) => key !== correctKey(attempt, id))

// Plan je Position: 'c' richtig, 'w' falsch, '-' unbeantwortet. Start (now) und Abgabe (finalizedAt) sind steuerbar.
async function seedCompleted({ language = 'de', plan = ['c', 'w', '-'], startedAt = 1000, completedAt = 5000, seed = 7 } = {}) {
  return withStore(async (store) => {
    const { started, attempt } = await startExam(store, { preset: 'short', language, random: seededRandom(seed), now: startedAt })

    expect(started).toBe(true)

    for (const [index, id] of attempt.orderedQuestionIds.entries()) {
      const mark = plan[index % plan.length]

      if (mark !== '-') {
        await store.recordExamAnswer({
          examSessionId: attempt.examSessionId,
          questionId: id,
          selectedOptionKey: mark === 'c' ? correctKey(attempt, id) : wrongKey(attempt, id),
          now: startedAt + 1,
        })
      }
    }

    const done = await store.finalizeExamAttempt(attempt.examSessionId, completedAt)

    expect(done.finalized).toBe(true)

    return done.attempt
  })
}

// Vom bereits geöffneten Startscreen aus.
async function startFromStartScreen(app, preset = 'short') {
  app.container.querySelector(`[data-preset="${preset}"]`).click()
  await settle(10)
  examButton(app.container, 'start').click()
  await vi.waitFor(() => expect(app.container.querySelector('.exam-card')).not.toBeNull())
  await settle(20)
}

async function openLastResultFromStart(app) {
  examButton(app.container, 'last-result').click()
  await vi.waitFor(() => expect(app.container.querySelector('.exam-result')).not.toBeNull())
  await settle(10)
}

async function openLastResult(app) {
  await openExam(app)
  examButton(app.container, 'last-result').click()
  await vi.waitFor(() => expect(app.container.querySelector('.exam-result')).not.toBeNull())
  await settle(10)
}

// Öffnet das letzte Ergebnis, ohne auf eine Zusammenfassung zu warten (für beschädigte Datensätze).
async function clickLastResult(app) {
  await openExam(app)
  examButton(app.container, 'last-result').click()
}

async function openReview(app) {
  examButton(app.container, 'review').click()
  await vi.waitFor(() => expect(app.container.querySelector('.exam-review')).not.toBeNull())
  await settle(10)
}

const positionOf = (container) => container.querySelector('.exam-position')?.textContent.trim()

// Zustand der aktuell angezeigten Review-Frage aus dem DOM.
function reviewState(container) {
  return {
    position: positionOf(container),
    status: container.querySelector('[data-review-status]').dataset.reviewStatus,
    text: container.querySelector('.exam-question-text').textContent.trim(),
    options: [...container.querySelectorAll('.exam-review-option')].map((item) => ({
      key: item.dataset.optionKey,
      text: item.querySelector('.exam-review-option-text').textContent.trim(),
      selectedTag: item.querySelector('[data-tag="selected"]') !== null,
      correctTag: item.querySelector('[data-tag="correct"]') !== null,
      markedCorrect: item.classList.contains('review-option-correct'),
      markedWrong: item.classList.contains('review-option-wrong'),
    })),
    noAnswerHint: container.querySelector('.exam-review-noanswer') !== null,
    explanation: container.querySelector('[data-review="explanation"]').textContent.trim(),
    memoryAid: container.querySelector('[data-review="memory-aid"]')?.textContent.replace(/\s+/g, ' ').trim() ?? null,
    memoryAidType: container.querySelector('[data-review="memory-aid"]')?.dataset.memoryAidType ?? null,
  }
}

// Alle Fragen des Reviews nacheinander lesen (Weiter-Schaltfläche).
async function readReview(container, total = TOTAL) {
  const states = [reviewState(container)]

  for (let index = 1; index < total; index++) {
    examButton(container, 'review-next').click()
    await vi.waitFor(() => expect(positionOf(container)).toMatch(new RegExp(`\\b${index + 1}\\b`)))
    states.push(reviewState(container))
  }

  return states
}

// Erwartung allein aus dem gespeicherten Versuch.
function expectedItem(attempt, index) {
  const id = attempt.orderedQuestionIds[index]
  const snapshot = attempt.questionSnapshots[id]
  const selected = attempt.answers[id] ?? null

  return {
    id,
    status: selected === null ? 'unanswered' : selected === snapshot.correctOptionKey ? 'correct' : 'incorrect',
    text: snapshot.content.question,
    keys: attempt.optionOrder[id],
    texts: attempt.optionOrder[id].map((key) => snapshot.content.optionText[key]),
    selected,
    correct: snapshot.correctOptionKey,
    explanation: snapshot.content.explanation,
    memoryAid: snapshot.content.memoryAid,
  }
}

const storedAttempts = () => withStore((store) => store.listExamAttempts())
const activeAttempt = () => withStore((store) => store.getActiveExamAttempt())

function rawDelete(storeNames) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME)

    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction(storeNames, 'readwrite')

      storeNames.forEach((storeName) => transaction.objectStore(storeName).clear())
      transaction.oncomplete = () => {
        database.close()
        resolve()
      }
      transaction.onerror = () => reject(transaction.error)
    }
    request.onerror = () => reject(request.error)
  })
}

function rawPut(record) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME)

    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction('examAttempts', 'readwrite')

      transaction.objectStore('examAttempts').put(record)
      transaction.oncomplete = () => {
        database.close()
        resolve()
      }
      transaction.onerror = () => reject(transaction.error)
    }
    request.onerror = () => reject(request.error)
  })
}

const key = (target, init) => {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })

  target.dispatchEvent(event)

  return event
}

// --- A–E Review öffnen, Antwortzustände ----------------------------------------------------------------------------

describe('result → review', () => {
  it('A: the result summary offers "Antworten prüfen" and opens the question-by-question review after a real submit', async () => {
    let app = await setup()

    await startUi(app)
    await withStore(async (store) => {
      const attempt = await store.getActiveExamAttempt()

      await store.recordExamAnswer({ examSessionId: attempt.examSessionId, questionId: attempt.orderedQuestionIds[0], selectedOptionKey: correctKey(attempt, attempt.orderedQuestionIds[0]) })
    })
    app = await remount(app) // laufende Prüfung wird fortgesetzt
    await openExam(app)
    examButton(app.container, 'submit').click()
    await vi.waitFor(() => expect(app.container.querySelector('.exam-dialog')).not.toBeNull())
    examButton(app.container, 'confirm').click()
    await vi.waitFor(() => expect(app.container.querySelector('.exam-result')).not.toBeNull())

    expect(examButton(app.container, 'review').textContent.trim()).toBe('Antworten prüfen')
    await openReview(app)

    expect(app.container.querySelector('.exam-review h2').textContent.trim()).toBe('Antworten prüfen')
    expect(positionOf(app.container)).toBe(`Frage 1 von ${TOTAL}`)
    expect(app.container.querySelector('.exam-result')).toBeNull()
  })

  it('B–E: shows own answer, correct answer and the status correct / incorrect / unanswered for every question', async () => {
    let app = await setup()
    const done = await seedCompleted({ plan: ['c', 'w', '-'] })

    app = await remount(app)
    await openLastResult(app)
    await openReview(app)

    const { container } = app
    const states = await readReview(container)

    expect(states).toHaveLength(TOTAL)
    states.forEach((state, index) => {
      const expected = expectedItem(done, index)

      expect(state.position).toBe(`Frage ${index + 1} von ${TOTAL}`)
      expect(state.status, `Frage ${index + 1}`).toBe(expected.status)
      expect(state.text).toBe(expected.text)
      expect(state.options.map((option) => option.key)).toEqual(expected.keys) // gespeicherte Optionsreihenfolge
      expect(state.options.map((option) => option.text)).toEqual(expected.texts)

      // E: richtige Antwort immer markiert (auch bei falsch und unbeantwortet), und nur sie
      expect(state.options.filter((option) => option.correctTag).map((option) => option.key)).toEqual([expected.correct])
      expect(state.options.filter((option) => option.markedCorrect).map((option) => option.key)).toEqual([expected.correct])

      if (expected.status === 'unanswered') {
        // D: keine eigene Antwort behaupten
        expect(state.options.some((option) => option.selectedTag)).toBe(false)
        expect(state.options.some((option) => option.markedWrong)).toBe(false)
        expect(state.noAnswerHint).toBe(true)
      } else {
        expect(state.options.filter((option) => option.selectedTag).map((option) => option.key)).toEqual([expected.selected])
      }

      if (expected.status !== 'unanswered') {
        expect(state.noAnswerHint).toBe(false)
      }

      if (expected.status === 'incorrect') {
        // C: eigene falsche Auswahl klar markiert (zusätzlich zur richtigen)
        expect(state.options.filter((option) => option.markedWrong).map((option) => option.key)).toEqual([expected.selected])
      }

      if (expected.status === 'correct') {
        expect(state.options.some((option) => option.markedWrong)).toBe(false)
      }
    })

    const statuses = states.map((state) => state.status)

    expect(new Set(statuses)).toEqual(new Set(['correct', 'incorrect', 'unanswered']))
  })

  it('F/G: explanation and memory aid appear only in the completed review (never in the running exam or the summary), taken from the snapshot', async () => {
    let app = await setup()

    await startUi(app)
    // laufend: weder Erklärung noch Merkhilfe noch Review-Bedienelemente im DOM
    expect(text(app.container)).not.toMatch(/Synthetische Erklärung|Synthetisch\.|Merkhilfe|Erklärung/)
    expect(app.container.querySelector('.exam-review, [data-exam="review"]')).toBeNull()
    expect(app.container.querySelector('[data-review]')).toBeNull()

    const running = await activeAttempt()

    await withStore((store) => store.finalizeExamAttempt(running.examSessionId, 5000))
    app = await remount(app)
    await openLastResult(app)
    expect(text(app.container)).not.toMatch(/Synthetische Erklärung|Merkhilfe/) // Zusammenfassung: noch keine Lösungsdetails

    const done = (await storedAttempts())[0]

    await openReview(app)

    const states = await readReview(app.container)

    states.forEach((state, index) => {
      const expected = expectedItem(done, index)

      expect(state.explanation).toBe(expected.explanation)
      expect(state.memoryAid).toBe(`Merkhilfe: ${expected.memoryAid.text}`)
      expect(state.memoryAidType).toBe(expected.memoryAid.type) // Typ unverändert durchgereicht
    })
  })

  it('G: a snapshot without memory aid shows no memory-aid block', async () => {
    const app = await setup()
    const done = await seedCompleted()
    const id = done.orderedQuestionIds[0]
    const stripped = clone(done)

    stripped.questionSnapshots[id].content.memoryAid = null
    await rawPut(stripped)

    const next = await remount(app)

    await openLastResult(next)
    await openReview(next)

    expect(reviewState(next.container).memoryAid).toBeNull()
    expect(next.container.querySelector('[data-review="explanation"]')).not.toBeNull()
  })
})

// --- H–N Quelle, Reihenfolge, Read-only, Reload, Sprache ----------------------------------------------------------

describe('review source and read-only guarantees', () => {
  it('H: uses exactly the stored option order of the exam for every question', async () => {
    const app = await setup()
    const done = await seedCompleted({ plan: ['c', 'w'] })
    const next = await remount(app)

    await openLastResult(next)
    await openReview(next)

    const states = await readReview(next.container)

    states.forEach((state, index) => expect(state.options.map((option) => option.key)).toEqual(done.optionOrder[done.orderedQuestionIds[index]]))
    expect(new Set(states.map((state) => state.options.map((option) => option.key).join(''))).size).toBeGreaterThan(1) // nicht pauschal neu sortiert
  })

  it('I/J: a later library update (texts, correct keys, explanations, revisions) does not change the review', async () => {
    const app = await setup()
    const done = await seedCompleted({ plan: ['c', 'w', '-'] })
    const changed = makeExamLibraryData(SIZES, {
      overrides: Object.fromEntries(
        Object.entries(SIZES).map(([sectionId, count], index) => [
          sectionId,
          {
            libraryVersion: '2.0.0',
            activeQuestionIndexHash: `sha256:${'abc'[index].repeat(64)}`,
            questionLabel: 'NEU',
            contentRevisions: Object.fromEntries(Array.from({ length: count }, (_, item) => [`sec-a${sectionId.slice(2)}-${String(item + 1).padStart(4, '0')}`, 2])),
          },
        ]),
      ),
    })

    changed.forEach((data) =>
      data.questions.forEach((question) => {
        question.correctOptionKey = question.correctOptionKey === 'a' ? 'b' : 'a'
        question.localized.de.explanation = 'NEUE ERKLÄRUNG'
        question.localized.de.memoryAid.text = 'NEUE MERKHILFE'
      }),
    )
    await withStore(async (store) => {
      for (const data of changed) {
        const parsed = parseV2Library(data)
        const result = await applyLibraryUpdate(store, parsed.library, { questions: parsed.questions })

        expect(result.libraryState.libraryVersion).toBe('2.0.0')
      }
    })

    const next = await remount(app)

    await openLastResult(next)
    await openReview(next)

    const states = await readReview(next.container)

    states.forEach((state, index) => {
      const expected = expectedItem(done, index)

      expect(state.status).toBe(expected.status)
      expect(state.text).toBe(expected.text)
      expect(state.explanation).toBe(expected.explanation)
      expect(state.options.filter((option) => option.markedCorrect).map((option) => option.key)).toEqual([expected.correct])
    })
    expect(text(next.container)).not.toMatch(/NEU/)
  })

  it('K: a completed exam stays reviewable after all libraries were removed (and the exam tile is still reachable)', async () => {
    const app = await setup()
    const done = await seedCompleted({ plan: ['w', 'c', '-', 'c'] })

    await rawDelete(['libraries', 'libraryContent', 'progress', 'sessions'])

    const next = await remount(app)

    expect(tile(next.container).textContent).toContain('Prüfungsmodus')
    await openLastResult(next)
    await openReview(next)

    const states = await readReview(next.container)

    states.forEach((state, index) => {
      const expected = expectedItem(done, index)

      expect(state.status).toBe(expected.status)
      expect(state.options.map((option) => option.text)).toEqual(expected.texts)
      expect(state.explanation).toBe(expected.explanation)
    })
  })

  it('L: the review is read-only: no answer controls, no writes, the stored attempt stays bit-identical', async () => {
    const app = await setup()
    const done = await seedCompleted()
    const next = await remount(app)

    await openLastResult(next)

    const original = IDBDatabase.prototype.transaction
    const modes = []

    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (names, mode) {
      modes.push(mode ?? 'readonly')

      return original.call(this, names, mode)
    })
    await openReview(next)
    await readReview(next.container)

    expect(next.container.querySelectorAll('.exam-review .answer-button, .exam-review .exam-option, .exam-review [aria-pressed], .exam-review input, .exam-review select, .exam-review textarea')).toHaveLength(0)
    expect([...next.container.querySelectorAll('.exam-review button')].map((button) => button.dataset.exam).sort()).toEqual(['review-back', 'review-next', 'review-result'])
    expect(modes.filter((mode) => mode === 'readwrite')).toEqual([])
    vi.restoreAllMocks()
    expect(await storedAttempts()).toEqual([done])
  })

  it('L: the review only ever calls read methods of the store (source guard)', () => {
    const source = readFileSync(join(componentsDir, 'ExamReview.vue'), 'utf8')

    ;['store', 'recordExamAnswer', 'setExamPosition', 'finalizeExamAttempt', 'discardExamAttempt', 'discardActiveExamAttempt', 'startExam', 'scoreExamAttempt', 'QuizCard', 'ScoreBox', 'recordAnswer', 'recordSessionAnswer', 'startNewSession', 'indexedDB', 'getLibraryContent', 'readExamPool'].forEach(
      (forbidden) => expect(source.includes(forbidden), forbidden).toBe(false),
    )
  })

  it('M: reload in the review: no running exam appears, the last result and the review are available again', async () => {
    const app = await setup()
    const done = await seedCompleted()
    let next = await remount(app)

    await openLastResult(next)
    await openReview(next)
    examButton(next.container, 'review-next').click()
    await vi.waitFor(() => expect(positionOf(next.container)).toBe(`Frage 2 von ${TOTAL}`))

    next = await remount(next)
    expect(await activeAttempt()).toBeNull()
    expect(tile(next.container).textContent).toContain('Prüfungsmodus starten') // kein Resume
    await openExam(next)
    expect(next.container.querySelector('.exam-card')).toBeNull()
    expect(next.container.querySelector('.exam-start')).not.toBeNull()
    await openLastResultFromStart(next)
    await openReview(next)

    expect(positionOf(next.container)).toBe(`Frage 1 von ${TOTAL}`)
    expect(reviewState(next.container).text).toBe(expectedItem(done, 0).text)
    expect(await storedAttempts()).toEqual([done])
  })

  it('N: UI language is independent of the exam language (labels follow the UI, content stays in the exam language)', async () => {
    const app = await setup()
    const english = await seedCompleted({ language: 'en', completedAt: 5000 })
    const next = await remount(app)

    await openLastResult(next)
    await openReview(next)

    // Prüfung Englisch, UI Deutsch
    expect(text(next.container)).toContain('Richtige Antwort')
    expect(reviewState(next.container).text).toBe(expectedItem(english, 0).text)
    expect(reviewState(next.container).text).toContain('EN')
    expect(reviewState(next.container).explanation).toContain('Synthetic explanation')

    // UI Englisch, Prüfung unverändert Englisch
    await switchLanguage(next.container, 'en')
    expect(text(next.container)).toContain('Correct answer')
    expect(text(next.container)).toContain('Question 1 of')
    expect(reviewState(next.container).text).toBe(expectedItem(english, 0).text)

    // Prüfung Deutsch, UI Englisch
    await rawDelete(['examAttempts']) // Testdaten zurücksetzen (der Store selbst löscht keine abgegebenen Versuche)

    const german = await seedCompleted({ language: 'de', startedAt: 6000, completedAt: 7000, seed: 8 })
    const again = await remount(next)

    await openLastResult(again)
    await openReview(again)
    expect(text(again.container)).toContain('Correct answer')
    expect(reviewState(again.container).text).toBe(expectedItem(german, 0).text)
    expect(reviewState(again.container).text).toContain('Frage')
    expect(reviewState(again.container).explanation).toContain('Synthetische Erklärung')
  })

  it('the review navigation is bounded and returns to the result summary and from there to the overview', async () => {
    const app = await setup()

    await seedCompleted()

    const next = await remount(app)

    await openLastResult(next)

    const summary = text(next.container.querySelector('.exam-result'))

    await openReview(next)
    expect(examButton(next.container, 'review-back').disabled).toBe(true)
    expect(examButton(next.container, 'review-next').disabled).toBe(false)

    for (let index = 1; index < TOTAL; index++) {
      examButton(next.container, 'review-next').click()
      await vi.waitFor(() => expect(positionOf(next.container)).toBe(`Frage ${index + 1} von ${TOTAL}`))
    }

    expect(examButton(next.container, 'review-next').disabled).toBe(true)
    // Fokus ging nicht verloren, als „Weiter“ an der Grenze deaktiviert wurde
    expect(document.activeElement).not.toBe(document.body)

    examButton(next.container, 'review-back').click()
    await vi.waitFor(() => expect(positionOf(next.container)).toBe(`Frage ${TOTAL - 1} von ${TOTAL}`))

    examButton(next.container, 'review-result').click()
    await vi.waitFor(() => expect(next.container.querySelector('.exam-result')).not.toBeNull())
    expect(next.container.querySelector('.exam-review')).toBeNull()
    expect(text(next.container.querySelector('.exam-result'))).toBe(summary) // Summary unverändert (attempt.result)

    examButton(next.container, 'close').click()
    await vi.waitFor(() => expect(next.container.querySelector('.exam-mode')).toBeNull())
    expect(tile(next.container)).not.toBeNull()
  })

  it('moves the focus to the review heading when the review opens and back to the result heading', async () => {
    const app = await setup()

    await seedCompleted()

    const next = await remount(app)

    await openLastResult(next)
    await openReview(next)
    expect(document.activeElement).toBe(next.container.querySelector('.exam-review h2'))
    examButton(next.container, 'review-result').click()
    await vi.waitFor(() => expect(next.container.querySelector('.exam-result')).not.toBeNull())
    await settle(10)
    expect(document.activeElement).toBe(next.container.querySelector('.exam-result h2'))
  })

  it('the review marks the states with text and symbol, not only with colour', async () => {
    const app = await setup()

    await seedCompleted({ plan: ['c', 'w', '-'] })

    const next = await remount(app)

    await openLastResult(next)
    await openReview(next)

    const labels = new Set()

    for (let index = 0; index < 3; index++) {
      labels.add(next.container.querySelector('.exam-review-status').textContent.replace(/\s+/g, ' ').trim())
      if (index < 2) {
        examButton(next.container, 'review-next').click()
        await vi.waitFor(() => expect(positionOf(next.container)).toBe(`Frage ${index + 2} von ${TOTAL}`))
      }
    }

    expect(labels).toEqual(new Set(['✓ Richtig', '✗ Falsch', '– Unbeantwortet']))
  })
})

// --- O–R letztes Ergebnis ------------------------------------------------------------------------------------------

describe('last result', () => {
  it('O/P: opens the submitted attempt with the newest completedAt (not the newest start, not the list order) and shows its stored result', async () => {
    const app = await setup()
    const first = await seedCompleted({ plan: ['c', 'c', 'w', '-'], startedAt: 1000, completedAt: 9000, seed: 11 }) // 50 %, jüngste Abgabe
    const second = await seedCompleted({ plan: ['c'], startedAt: 2000, completedAt: 3000, seed: 12 }) // 100 %
    const third = await seedCompleted({ plan: ['-'], startedAt: 4000, completedAt: 5000, seed: 13 }) // 0 %, jüngster Start

    expect([first.result.percent, second.result.percent, third.result.percent]).toEqual([50, 100, 0])

    const next = await remount(app)

    await openLastResult(next)

    expect(next.container.querySelector('[data-exam-last]').textContent.trim()).toBe('Letztes Ergebnis')
    expect(next.container.querySelector('[data-result="percent"]').textContent.trim()).toBe('50 %')
    expect(next.container.querySelector('[data-result="correct"]').textContent.trim()).toBe(String(first.result.correct))
    expect(next.container.querySelector('[data-result="unanswered"]').textContent.trim()).toBe(String(first.result.unanswered))
    expect(await storedAttempts()).toHaveLength(3) // keine Historie in der UI, aber alle bleiben gespeichert
    expect(next.container.querySelectorAll('.exam-result').length).toBe(1)
  })

  it('P: from the reopened result a new exam can be started', async () => {
    const app = await setup()

    await seedCompleted()

    const next = await remount(app)

    await openLastResult(next)
    examButton(next.container, 'new').click()
    await vi.waitFor(() => expect(next.container.querySelector('.exam-start')).not.toBeNull())
    expect(examButton(next.container, 'last-result')).not.toBeNull() // weiterhin erreichbar, bis ein neues Ergebnis existiert
    next.container.querySelector('[data-preset="short"]').click()
    await settle(10)
    examButton(next.container, 'start').click()
    await vi.waitFor(() => expect(next.container.querySelector('.exam-card')).not.toBeNull())
    expect(await activeAttempt()).toMatchObject({ status: 'inProgress', questionCount: TOTAL })
  })

  it('Q: without any submitted attempt there is no "Letztes Ergebnis ansehen" button (neither on the start screen nor on the tile)', async () => {
    const app = await setup()

    await openExam(app)
    expect(examButton(app.container, 'last-result')).toBeNull()
    expect(text(app.container)).not.toContain('Letztes Ergebnis')

    // ein laufender (nicht abgegebener) Versuch ist kein Ergebnis
    app.container.querySelector('[data-preset="short"]').click()
    await settle(10)
    examButton(app.container, 'start').click()
    await vi.waitFor(() => expect(app.container.querySelector('.exam-card')).not.toBeNull())

    const next = await remount(app)

    expect(text(tile(next.container))).not.toContain('Letztes Ergebnis')
  })

  it('R: a running attempt has resume priority; the last result is not offered while it exists', async () => {
    const app = await setup()

    await seedCompleted()
    await withStore((store) => startExam(store, { preset: 'short', random: seededRandom(21), now: 8000 }))

    const next = await remount(app)

    expect(tile(next.container).textContent).toContain('Laufende Prüfung fortsetzen')
    await openExam(next)
    expect(next.container.querySelector('.exam-card')).not.toBeNull()
    expect(next.container.querySelector('.exam-start')).toBeNull()
    expect(examButton(next.container, 'last-result')).toBeNull()
  })

  it('the English UI offers "View last result"', async () => {
    const app = await setup()

    await seedCompleted()

    const next = await remount(app)

    await switchLanguage(next.container, 'en')
    await openExam(next)
    expect(examButton(next.container, 'last-result').textContent.trim()).toBe('View last result')
  })
})

// --- S–Z Verwerfen -------------------------------------------------------------------------------------------------

describe('discard a running exam', () => {
  async function running(app) {
    await startUi(app)
    await withStore(async (store) => {
      const attempt = await store.getActiveExamAttempt()

      await store.recordExamAnswer({ examSessionId: attempt.examSessionId, questionId: attempt.orderedQuestionIds[0], selectedOptionKey: 'a' })
    })

    return activeAttempt()
  }

  it('S: "Prüfung verwerfen" exists only for a running exam (not on start, result, review or damaged result)', async () => {
    const app = await setup()

    await openExam(app)
    expect(examButton(app.container, 'discard-open')).toBeNull()

    app.container.querySelector('[data-preset="short"]').click()
    await settle(10)
    examButton(app.container, 'start').click()
    await vi.waitFor(() => expect(app.container.querySelector('.exam-card')).not.toBeNull())
    expect(examButton(app.container, 'discard-open').textContent.trim()).toBe('Prüfung verwerfen')

    const running = await activeAttempt()
    const done = (await withStore((store) => store.finalizeExamAttempt(running.examSessionId, 5000))).attempt
    const next = await remount(app)

    await openLastResult(next)
    expect(examButton(next.container, 'discard-open')).toBeNull()
    await openReview(next)
    expect(examButton(next.container, 'discard-open')).toBeNull()

    await rawPut({ ...clone(done), result: { ...done.result, percent: done.result.percent + 1 } })

    const damaged = await remount(next)

    await clickLastResult(damaged)
    await vi.waitFor(() => expect(damaged.container.querySelector('.exam-damaged')).not.toBeNull())
    expect(examButton(damaged.container, 'discard-open')).toBeNull()
  })

  it('T: requires a confirmation: modal alert dialog with warning, background disabled, nothing deleted yet', async () => {
    const app = await setup()
    const before = await running(app)
    const trigger = examButton(app.container, 'discard-open')

    trigger.focus()
    trigger.click()
    await vi.waitFor(() => expect(app.container.querySelector('.exam-dialog')).not.toBeNull())
    await settle(10)

    const dialog = app.container.querySelector('.exam-dialog')

    expect(dialog.getAttribute('role')).toBe('alertdialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.activeElement).toBe(dialog)
    expect(dialog.textContent).toContain('gehen verloren')
    expect(dialog.textContent).toContain('nicht rückgängig')
    expect([...dialog.querySelectorAll('button')].map((button) => button.textContent.trim())).toEqual(['Abbrechen', 'Verwerfen'])
    expect(options(app.container).every((button) => button.disabled)).toBe(true)
    ;['back', 'next', 'submit', 'discard-open'].forEach((name) => expect(examButton(app.container, name).disabled, name).toBe(true))
    expect(await activeAttempt()).toEqual(before)
  })

  it('U: cancel (button and Escape) keeps the exam active and unchanged and returns the focus to the trigger', async () => {
    const app = await setup()
    const before = await running(app)

    for (const close of [() => examButton(app.container, 'discard-cancel').click(), () => key(app.container.querySelector('.exam-dialog'), { key: 'Escape' })]) {
      const trigger = examButton(app.container, 'discard-open')

      trigger.focus()
      trigger.click()
      await vi.waitFor(() => expect(app.container.querySelector('.exam-dialog')).not.toBeNull())
      await settle(10)
      close()
      await vi.waitFor(() => expect(app.container.querySelector('.exam-dialog')).toBeNull())
      await settle(10)

      expect(document.activeElement).toBe(trigger)
      expect(options(app.container).every((button) => !button.disabled)).toBe(true)
      expect(await activeAttempt()).toEqual(before)
    }
  })

  it('keeps Tab and Shift+Tab inside the discard dialog', async () => {
    const app = await setup()

    await running(app)
    examButton(app.container, 'discard-open').click()
    await vi.waitFor(() => expect(app.container.querySelector('.exam-dialog')).not.toBeNull())
    await settle(10)

    const dialog = app.container.querySelector('.exam-dialog')
    const [first, last] = [...dialog.querySelectorAll('button')]

    last.focus()
    expect(key(last, { key: 'Tab' }).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(first)
    expect(key(first, { key: 'Tab', shiftKey: true }).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(last)
    dialog.focus()
    key(dialog, { key: 'Tab' })
    expect(document.activeElement).toBe(first)
    first.focus()
    expect(key(first, { key: 'Tab' }).defaultPrevented).toBe(false) // dazwischen nicht blockieren
  })

  it('V/W/X: confirming deletes only the running attempt, shows the start screen, offers no resume and allows a new start immediately', async () => {
    const app = await setup()
    const before = await running(app)
    const trigger = examButton(app.container, 'discard-open')

    trigger.click()
    await vi.waitFor(() => expect(app.container.querySelector('.exam-dialog')).not.toBeNull())
    examButton(app.container, 'discard-confirm').click()
    await vi.waitFor(() => expect(app.container.querySelector('.exam-start')).not.toBeNull())
    await settle(10)

    expect(await storedAttempts()).toEqual([])
    expect(await activeAttempt()).toBeNull()
    expect(app.container.querySelector('.exam-card')).toBeNull()
    expect(text(app.container)).toContain('Die Prüfung wurde verworfen')
    expect(document.activeElement).toBe(app.container.querySelector('.exam-start h2'))

    // W: kein Resume nach Überblick und Reload
    examButton(app.container, 'close').click()
    await vi.waitFor(() => expect(tile(app.container).textContent).toContain('Prüfungsmodus starten'))

    const next = await remount(app)

    expect(tile(next.container).textContent).not.toContain('fortsetzen')

    // X: neuer Start sofort möglich, ohne Geisterversuch
    await startUi(next, { preset: 'short' })

    const fresh = await activeAttempt()

    expect(fresh.examSessionId).not.toBe(before.examSessionId)
    expect(fresh.answers).toEqual({})
    expect(await storedAttempts()).toHaveLength(1)
  })

  it('Y: a submitted attempt cannot be discarded: a stale tab keeps the result untouched and shows it', async () => {
    const stale = await setup()
    const before = await running(stale)

    const { attempt: done } = await withStore((store) => store.finalizeExamAttempt(before.examSessionId, 6000)) // „Tab B“ gibt ab

    // „Tab A“ zeigt noch die laufende Prüfung und will verwerfen
    expect(stale.container.querySelector('.exam-card')).not.toBeNull()
    examButton(stale.container, 'discard-open').click()
    await vi.waitFor(() => expect(stale.container.querySelector('.exam-dialog')).not.toBeNull())
    examButton(stale.container, 'discard-confirm').click()
    await vi.waitFor(() => expect(stale.container.querySelector('.exam-result')).not.toBeNull())

    expect(text(stale.container)).toContain('bereits abgegeben')
    expect(await storedAttempts()).toEqual([done])
    expect(examButton(stale.container, 'discard-open')).toBeNull()
  })

  it('Z: after another tab discarded the exam, answers, navigation and submit in the stale tab write nothing and lead to the persisted state', async () => {
    const tabA = await setup()
    const before = await running(tabA)
    const tabB = mountApp()

    await vi.waitFor(() => expect(tile(tabB.container)).not.toBeNull())
    await settle(30)
    await openExam(tabB)
    expect(tabB.container.querySelector('.exam-card')).not.toBeNull()

    // Tab A verwirft
    examButton(tabA.container, 'discard-open').click()
    await vi.waitFor(() => expect(tabA.container.querySelector('.exam-dialog')).not.toBeNull())
    examButton(tabA.container, 'discard-confirm').click()
    await vi.waitFor(() => expect(tabA.container.querySelector('.exam-start')).not.toBeNull())
    expect(await storedAttempts()).toEqual([])

    // Tab B beantwortet: nichts wird geschrieben, kein Wiederauferstehen
    options(tabB.container)[1].click()
    await vi.waitFor(() => expect(tabB.container.querySelector('.exam-start')).not.toBeNull())
    expect(text(tabB.container)).toContain('existiert nicht mehr')
    expect(await storedAttempts()).toEqual([])
    expect(tabB.container.querySelector('.exam-card')).toBeNull()

    // Tab A startet neu; ein veralteter Tab darf den neuen Versuch nicht anfassen
    await startFromStartScreen(tabA)

    const fresh = await activeAttempt()

    expect(fresh.examSessionId).not.toBe(before.examSessionId)

    // Tab C hängt am alten (gelöschten) Versuch, Navigation und Abgabe laufen ins Leere
    const stored = await withStore(async (store) => ({
      moved: await store.setExamPosition({ examSessionId: before.examSessionId, direction: 'next' }),
      answered: await store.recordExamAnswer({ examSessionId: before.examSessionId, questionId: before.orderedQuestionIds[0], selectedOptionKey: 'b' }),
      finalized: await store.finalizeExamAttempt(before.examSessionId, 9000),
      discarded: await store.discardActiveExamAttempt(before.examSessionId),
    }))

    expect(stored.moved).toMatchObject({ moved: false, reason: 'notFound' })
    expect(stored.answered).toMatchObject({ recorded: false, reason: 'notFound' })
    expect(stored.finalized).toMatchObject({ finalized: false, reason: 'notFound' })
    expect(stored.discarded).toMatchObject({ discarded: false, reason: 'notFound' })
    expect(await activeAttempt()).toEqual(fresh)
  })

  it('Z: submit in a stale tab after a remote discard shows the persisted state instead of a result', async () => {
    const tabA = await setup()
    const before = await running(tabA)

    examButton(tabA.container, 'submit').click()
    await vi.waitFor(() => expect(tabA.container.querySelector('.exam-dialog')).not.toBeNull())
    await withStore((store) => store.discardActiveExamAttempt(before.examSessionId)) // anderer Tab verwirft
    examButton(tabA.container, 'confirm').click()
    await vi.waitFor(() => expect(tabA.container.querySelector('.exam-start')).not.toBeNull())

    expect(tabA.container.querySelector('.exam-result')).toBeNull()
    expect(tabA.container.querySelector('.exam-dialog')).toBeNull()
    expect(await storedAttempts()).toEqual([])
  })

  it('a failed discard keeps the dialog open, the exam active, and allows another attempt', async () => {
    const app = await setup()
    const before = await running(app)

    examButton(app.container, 'discard-open').click()
    await vi.waitFor(() => expect(app.container.querySelector('.exam-dialog')).not.toBeNull())

    const original = IDBDatabase.prototype.transaction
    let failures = 1

    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (names, mode) {
      if (mode === 'readwrite' && failures-- > 0) {
        throw new Error('simulierter Schreibfehler')
      }

      return original.call(this, names, mode)
    })
    examButton(app.container, 'discard-confirm').click()
    await vi.waitFor(() => expect(app.container.querySelector('.library-message-error')).not.toBeNull())

    expect(app.container.querySelector('.exam-dialog')).not.toBeNull()
    expect(await activeAttempt()).toEqual(before)
    expect(examButton(app.container, 'discard-confirm').disabled).toBe(false)

    examButton(app.container, 'discard-confirm').click()
    await vi.waitFor(() => expect(app.container.querySelector('.exam-start')).not.toBeNull())
    expect(await storedAttempts()).toEqual([])
  })

  it('a double click on "Verwerfen" performs one write only', async () => {
    const app = await setup()

    await running(app)
    examButton(app.container, 'discard-open').click()
    await vi.waitFor(() => expect(app.container.querySelector('.exam-dialog')).not.toBeNull())

    const original = IDBDatabase.prototype.transaction
    let writes = 0

    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (names, mode) {
      writes += mode === 'readwrite' ? 1 : 0

      return original.call(this, names, mode)
    })

    const confirm = examButton(app.container, 'discard-confirm')

    confirm.click()
    confirm.click()
    confirm.click()
    await vi.waitFor(() => expect(app.container.querySelector('.exam-start')).not.toBeNull())
    expect(writes).toBe(1)
  })
})

// --- AA/AB beschädigte Ergebnisse, fehlender Snapshot ---------------------------------------------------------------

describe('damaged completed attempts', () => {
  it('AA: a completed attempt that fails the validation shows a safe error, no invented result, no review and no repair', async () => {
    const app = await setup()
    const done = await seedCompleted()
    const tampered = { ...clone(done), result: { ...done.result, percent: done.result.percent + 1 } }

    await rawPut(tampered)

    const next = await remount(app)

    await clickLastResult(next)
    await vi.waitFor(() => expect(next.container.querySelector('.exam-damaged')).not.toBeNull())

    expect(text(next.container)).toContain('Ergebnis nicht lesbar')
    expect(next.container.querySelector('.result-grid, [data-result], [data-exam="review"], .exam-review')).toBeNull()
    expect(text(next.container)).not.toContain(`${tampered.result.percent} %`)
    expect(await storedAttempts()).toEqual([tampered]) // keine automatische Reparatur

    // zurück zur Prüfungsübersicht und ins Hauptmenü
    examButton(next.container, 'to-start').click()
    await vi.waitFor(() => expect(next.container.querySelector('.exam-start')).not.toBeNull())
    expect(next.container.querySelector('.exam-damaged')).toBeNull()
    examButton(next.container, 'close').click()
    await vi.waitFor(() => expect(next.container.querySelector('.exam-mode')).toBeNull())
  })

  it('AB: an incomplete snapshot never falls back to live library content (checked when the review opens)', async () => {
    const app = await setup()
    const done = await seedCompleted()
    const next = await remount(app)

    await openLastResult(next)

    // Der Datensatz wird nach dem Öffnen des Ergebnisses beschädigt: Erklärung eines Snapshots fehlt, die Library ist intakt.
    const broken = clone(done)

    delete broken.questionSnapshots[broken.orderedQuestionIds[4]].content.explanation
    await rawPut(broken)

    examButton(next.container, 'review').click()
    await vi.waitFor(() => expect(next.container.querySelector('.exam-damaged')).not.toBeNull())

    expect(next.container.querySelector('.exam-review')).toBeNull()
    expect(text(next.container)).not.toContain('Synthetische Erklärung') // keine Live-Erklärung eingemischt
    expect(await storedAttempts()).toEqual([broken])
  })

  it('AB: a completed attempt with a missing snapshot is rejected before the summary (no mix of historical and live data)', async () => {
    const app = await setup()
    const done = await seedCompleted()
    const broken = clone(done)

    delete broken.questionSnapshots[broken.orderedQuestionIds[0]]
    await rawPut(broken)

    const next = await remount(app)

    await openExam(next)
    examButton(next.container, 'last-result').click()
    await vi.waitFor(() => expect(next.container.querySelector('.exam-damaged')).not.toBeNull())
    expect(next.container.querySelector('.exam-result, .exam-review')).toBeNull()
  })

  it('the stale-tab "already submitted" path validates a submitted attempt before showing its result', async () => {
    const app = await setup()

    await startUi(app)

    const running = await activeAttempt()
    const { attempt: done } = await withStore((store) => store.finalizeExamAttempt(running.examSessionId, 5000))

    await rawPut({ ...clone(done), result: { ...done.result, percent: 77 } }) // Remote-Submit, danach beschädigt
    options(app.container)[0].click()
    await vi.waitFor(() => expect(app.container.querySelector('.exam-damaged')).not.toBeNull())
    expect(app.container.querySelector('[data-result]')).toBeNull()
  })
})

// --- AC–AE Feedback-Guard, Isolation, i18n, Quelltext ---------------------------------------------------------------

describe('feedback guard and isolation', () => {
  it('AC: a running exam never receives solutions, explanations, memory aids or the review route', async () => {
    const app = await setup()

    await startUi(app, { language: 'en' })
    options(app.container)[1].click()
    await settle(30)

    const running = await activeAttempt()
    const explanations = Object.values(running.questionSnapshots).map((snapshot) => snapshot.content.explanation)

    expect(app.container.querySelector('[data-review], .exam-review, [data-exam="review"], .review-option-correct, .exam-review-tag')).toBeNull()
    explanations.forEach((explanation) => expect(app.container.textContent).not.toContain(explanation))
    expect(app.container.querySelector('.answer-correct, .answer-wrong, .feedback-box')).toBeNull()
  })

  it('AD/AE: opening the last result, the review, discarding and restarting leave learning progress and sessions untouched', async () => {
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

    await seedCompleted()
    await withStore(async (store) => {
      // seedCompleted nutzt nur den Exam-Store: Lernzustand unverändert
      expect(await store.listAllProgress()).toEqual(before.progress)
    })

    const next = await remount(app)
    const original = IDBDatabase.prototype.transaction
    const writes = []

    await openLastResult(next)
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (names, mode) {
      if (mode === 'readwrite') {
        writes.push([names].flat().join(','))
      }

      return original.call(this, names, mode)
    })
    await openReview(next)
    await readReview(next.container)
    examButton(next.container, 'review-result').click()
    await vi.waitFor(() => expect(next.container.querySelector('.exam-result')).not.toBeNull())
    examButton(next.container, 'new').click()
    await vi.waitFor(() => expect(next.container.querySelector('.exam-start')).not.toBeNull())
    next.container.querySelector('[data-preset="short"]').click()
    await settle(10)
    examButton(next.container, 'start').click()
    await vi.waitFor(() => expect(next.container.querySelector('.exam-card')).not.toBeNull())
    examButton(next.container, 'discard-open').click()
    await vi.waitFor(() => expect(next.container.querySelector('.exam-dialog')).not.toBeNull())
    examButton(next.container, 'discard-confirm').click()
    await vi.waitFor(() => expect(next.container.querySelector('.exam-start')).not.toBeNull())
    vi.restoreAllMocks()

    expect(new Set(writes)).toEqual(new Set(['examAttempts']))
    expect(await snapshot()).toEqual(before)
    expect(next.container.querySelector('.score-card')).toBeNull()
  })

  it('i18n: every new key exists in German and English with the same placeholders and the new components contain no hard-coded visible text', () => {
    const used = new Set()
    const prefixes = new Set()

    ;['ExamReview', 'ExamDiscardPanel', 'ExamMode', 'ExamResult', 'ExamStart', 'ExamEntryCard'].forEach((name) => {
      const source = readFileSync(join(componentsDir, `${name}.vue`), 'utf8')
      const template = source.slice(source.indexOf('<template>'))
      const withoutExpressions = template.replace(/\{\{[\s\S]*?\}\}/g, '')
      const textNodes = withoutExpressions.replace(/<\/?[A-Za-z][\w.-]*(?:[^>"']|"[^"]*"|'[^']*')*>/g, '\u0000').split('\u0000').map((part) => part.trim()).filter(Boolean)
      const literalAttributes = [...template.matchAll(/\s(?:aria-label|title|placeholder|alt)="([^"]+)"/g)].map((match) => match[1])

      expect(textNodes, `${name}: Textknoten`).toEqual([])
      expect(literalAttributes, `${name}: Attribute`).toEqual([])
      ;[...source.matchAll(/t\(\s*'([^']+)'/g), ...source.matchAll(/msg\(\s*'([^']+)'/g)].forEach((match) => used.add(match[1]))
      ;[...source.matchAll(/t\(\s*`([^`$]+)\$\{/g)].forEach((match) => prefixes.add(match[1]))
    })

    prefixes.forEach((prefix) => {
      const deKeys = Object.keys(de).filter((name) => name.startsWith(prefix))
      const enKeys = Object.keys(en).filter((name) => name.startsWith(prefix))

      expect(deKeys.length, prefix).toBeGreaterThan(0)
      expect(enKeys.sort(), prefix).toEqual(deKeys.sort())
    })

    const required = [
      'exam.review.start', 'exam.review.title', 'exam.review.yourAnswer', 'exam.review.correctAnswer', 'exam.review.status.correct', 'exam.review.status.incorrect',
      'exam.review.status.unanswered', 'exam.review.explanation', 'exam.review.memoryAid', 'exam.review.backToResult', 'exam.result.last', 'exam.start.lastResult',
      'exam.discard.open', 'exam.discard.confirm', 'exam.discard.warning', 'exam.damagedResult.title', 'exam.damagedResult.text', 'exam.error.review',
    ]

    ;[...required, ...[...used].filter((name) => name.startsWith('exam.') || name === 'section.label')].forEach((name) => {
      expect(de[name], `de ${name}`).toBeTypeOf('string')
      expect(en[name], `en ${name}`).toBeTypeOf('string')
      expect(en[name].match(/\{\w+\}/g)?.sort(), name).toEqual(de[name].match(/\{\w+\}/g)?.sort())
    })
    expect(Object.keys(de).filter((name) => name.startsWith('exam.')).sort()).toEqual(Object.keys(en).filter((name) => name.startsWith('exam.')).sort())
    expect(de['exam.review.start']).toBe('Antworten prüfen')
    expect(en['exam.review.start']).toBe('Review answers')
    expect(de['exam.start.lastResult']).toBe('Letztes Ergebnis ansehen')
    expect(en['exam.start.lastResult']).toBe('View last result')
    expect(de['exam.discard.open']).toBe('Prüfung verwerfen')
    expect(en['exam.discard.open']).toBe('Discard exam')
  })
})

// --- Phase-3D-Narrow-Fix ---------------------------------------------------------------------------------------------

// Sammelt Fehler explizit, statt sich auf die globale unhandled-error-Erkennung des Testrunners zu verlassen.
function watchErrors(entry) {
  const errors = []
  const onWindowError = (event) => errors.push(event.error ?? event.message)
  const onRejection = (reason) => errors.push(reason)

  entry.app.config.errorHandler = (error) => errors.push(error)
  entry.app.config.warnHandler = (message) => message.includes('Unhandled error') && errors.push(message)
  window.addEventListener('error', onWindowError)
  process.on('unhandledRejection', onRejection)

  return {
    errors,
    stop() {
      window.removeEventListener('error', onWindowError)
      process.off('unhandledRejection', onRejection)
    },
  }
}

// Der "failed"-Zustand zeigt nur eine Karte mit „Zur Übersicht“ und keinen der regulären Bereiche.
const failedStateShown = (container) => container.querySelector('.exam-mode') !== null && !container.querySelector('.exam-start, .exam-card, .exam-result, .exam-damaged, .exam-review')

describe('P3D-RT-003: stale tab after a remote discard (explicit, no reliance on unhandled-error detection)', () => {
  async function twoTabs() {
    const tabA = await setup()

    await startUi(tabA)
    await withStore(async (store) => {
      const attempt = await store.getActiveExamAttempt()

      await store.recordExamAnswer({ examSessionId: attempt.examSessionId, questionId: attempt.orderedQuestionIds[0], selectedOptionKey: 'a' })
    })

    const before = await activeAttempt()
    const tabB = mountApp()

    await vi.waitFor(() => expect(tile(tabB.container)).not.toBeNull())
    await settle(30)
    await openExam(tabB)
    await vi.waitFor(() => expect(tabB.container.querySelector('.exam-card')).not.toBeNull())

    // Tab A verwirft über die UI; Tab B hält weiter die alte laufende Ansicht
    examButton(tabA.container, 'discard-open').click()
    await vi.waitFor(() => expect(tabA.container.querySelector('.exam-dialog')).not.toBeNull())
    examButton(tabA.container, 'discard-confirm').click()
    await vi.waitFor(() => expect(tabA.container.querySelector('.exam-start')).not.toBeNull())
    expect(await storedAttempts()).toEqual([])
    expect(tabB.container.querySelector('.exam-card')).not.toBeNull() // stale

    return { tabA, tabB, before }
  }

  function expectStartScreen(tab, watcher) {
    expect(watcher.errors, watcher.errors.map(String).join(' | ')).toEqual([])
    expect(watcher.errors.some((error) => error instanceof TypeError)).toBe(false)
    expect(tab.container.querySelector('.exam-start')).not.toBeNull()
    expect(tab.container.querySelector('.exam-card, .exam-dialog')).toBeNull()
    expect(tab.container.querySelector('.library-message-error')).toBeNull()
    expect(failedStateShown(tab.container)).toBe(false)
    expect(text(tab.container)).toContain('existiert nicht mehr')
    expect(examButton(tab.container, 'start')).not.toBeNull()
  }

  it('an answer in the stale tab throws nothing, persists nothing and lands on the start screen (not on "failed")', async () => {
    const { tabB } = await twoTabs()
    const watcher = watchErrors(tabB)

    options(tabB.container)[1].click()
    await vi.waitFor(() => expect(tabB.container.querySelector('.exam-start')).not.toBeNull())
    await settle(150)
    watcher.stop()

    expectStartScreen(tabB, watcher)
    expect(await storedAttempts()).toEqual([]) // keine Antwort, kein Ghost-Record
  })

  it('navigation in the stale tab behaves the same way', async () => {
    const { tabB } = await twoTabs()
    const watcher = watchErrors(tabB)

    examButton(tabB.container, 'next').click()
    await vi.waitFor(() => expect(tabB.container.querySelector('.exam-start')).not.toBeNull())
    await settle(150)
    watcher.stop()

    expectStartScreen(tabB, watcher)
    expect(await storedAttempts()).toEqual([])
  })

  it('a submit in the stale tab behaves the same way and shows no result', async () => {
    const { tabB } = await twoTabs()
    const watcher = watchErrors(tabB)

    examButton(tabB.container, 'submit').click()
    await vi.waitFor(() => expect(tabB.container.querySelector('.exam-dialog')).not.toBeNull())
    examButton(tabB.container, 'confirm').click()
    await vi.waitFor(() => expect(tabB.container.querySelector('.exam-start')).not.toBeNull())
    await settle(150)
    watcher.stop()

    expectStartScreen(tabB, watcher)
    expect(tabB.container.querySelector('.exam-result')).toBeNull()
    expect(await storedAttempts()).toEqual([])
  })

  it('a stale answer never reaches a new attempt that was started after the discard', async () => {
    const { tabA, tabB, before } = await twoTabs()

    await startFromStartScreen(tabA)

    const fresh = await activeAttempt()
    const watcher = watchErrors(tabB)

    expect(fresh.examSessionId).not.toBe(before.examSessionId)
    options(tabB.container)[2].click()
    await vi.waitFor(() => expect(tabB.container.querySelector('.exam-card')).not.toBeNull()) // Tab B zeigt den neuen Versuch
    await settle(150)
    watcher.stop()

    expect(watcher.errors).toEqual([])
    expect(await activeAttempt()).toEqual(fresh) // unverändert: keine Antwort aus dem alten Tab
    expect(fresh.answers).toEqual({})
    expect(await storedAttempts()).toHaveLength(1)
  })

  it('the error watcher really detects a render error (guard against a silent test)', async () => {
    const app = await setup()
    const watcher = watchErrors(app)

    // Ein künstlicher Renderfehler muss über den Handler ankommen, sonst wäre die Prüfung "keine Fehler" wertlos.
    app.app.config.errorHandler(new TypeError('probe'))
    watcher.stop()
    expect(watcher.errors.some((error) => error instanceof TypeError)).toBe(true)
  })
})

describe('P3D-RT-001: damaged-running discard uses the protected path', () => {
  it('discarding a damaged running exam via the UI leaves a completed attempt untouched', async () => {
    const app = await setup()
    const done = await seedCompleted()

    await withStore((store) => startExam(store, { preset: 'short', random: seededRandom(31), now: 8000 }))

    const running = await activeAttempt()

    await rawPut({ ...clone(running), currentIndex: 99 }) // beschädigt, laufend

    const next = await remount(app)

    await openExam(next)
    await vi.waitFor(() => expect(next.container.querySelector('.exam-damaged')).not.toBeNull())
    examButton(next.container, 'discard').click()
    await vi.waitFor(() => expect(next.container.querySelector('.exam-start')).not.toBeNull())

    expect(await activeAttempt()).toBeNull()
    expect(await storedAttempts()).toEqual([done])
  })

  it('exam components no longer reference the unconditional delete', () => {
    ;['ExamMode', 'ExamStart', 'ExamResult', 'ExamReview', 'ExamDiscardPanel'].forEach((name) => {
      const source = readFileSync(join(componentsDir, `${name}.vue`), 'utf8')

      expect(source.includes('discardExamAttempt'), name).toBe(false)
    })
    expect(readFileSync(join(process.cwd(), 'src/storage/progressStore.js'), 'utf8').match(/\bdiscardExamAttempt\b\s*[,(]/g)).toBeNull()
  })
})

describe('P3D-RT-002: invalid memoryAid.type in a completed attempt (UI)', () => {
  for (const language of ['de', 'en']) {
    it(`${language}: a completed attempt with a typeless memory aid shows the safe error, no result, no review, no live fallback`, async () => {
      const app = await setup()
      const done = await seedCompleted({ language })
      const id = done.orderedQuestionIds[3]
      const broken = clone(done)

      broken.questionSnapshots[id].content.memoryAid = { text: broken.questionSnapshots[id].content.memoryAid.text } // Typ fehlt
      await rawPut(broken)

      const next = await remount(app)

      await clickLastResult(next)
      await vi.waitFor(() => expect(next.container.querySelector('.exam-damaged')).not.toBeNull())

      expect(text(next.container)).toContain('Ergebnis nicht lesbar')
      expect(next.container.querySelector('.result-grid, [data-result], [data-exam="review"], .exam-review')).toBeNull()
      expect(text(next.container)).not.toMatch(/Synthetische Erklärung|Synthetic explanation/) // kein Live-Inhalt
      expect(await storedAttempts()).toEqual([broken]) // keine Reparatur
    })
  }

  it('the review is also refused when the type disappears after the result was opened', async () => {
    const app = await setup()
    const done = await seedCompleted()
    const next = await remount(app)

    await openLastResult(next)

    const broken = clone(done)

    delete broken.questionSnapshots[done.orderedQuestionIds[0]].content.memoryAid.type
    await rawPut(broken)
    examButton(next.container, 'review').click()
    await vi.waitFor(() => expect(next.container.querySelector('.exam-damaged')).not.toBeNull())
    expect(next.container.querySelector('.exam-review')).toBeNull()
    expect(await storedAttempts()).toEqual([broken])
  })

  it('a valid memory aid still opens the result and the review with its type (DE and EN)', async () => {
    for (const language of ['de', 'en']) {
      resetBrowserStorage()

      const app = await setup()

      await seedCompleted({ language })

      const next = await remount(app)

      await openLastResult(next)
      await openReview(next)
      expect(next.container.querySelector('[data-review="memory-aid"]').dataset.memoryAidType).toBe('mini_scenario')
      unmountAll()
    }
  })
})
