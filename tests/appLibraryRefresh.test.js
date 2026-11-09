// @vitest-environment jsdom
// 30-Tage-Erinnerung zur Library-Aktualisierung: nicht-blockierend, ohne Löschen/Sperren, Zeit deterministisch (Date.now gemockt;
// Fake-Timer scheiden aus, weil vi.waitFor sie vorspult).
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  answerCurrent,
  heading,
  importFiles,
  mountApp,
  openSection,
  reloadWithoutImport,
  resetBrowserStorage,
  resume,
  sectionCards,
  settle,
  startQuiz,
  switchLanguage,
  unmountApp,
  unmountAll,
  withStore,
} from './helpers/appHarness.js'
import { makeSyntheticLibrary } from './fixtures/syntheticLibrary.js'
import { makeExamLibraryData } from './fixtures/examFixtures.js'
import { DB_NAME } from '../src/storage/progressStore.js'

const DAY = 24 * 60 * 60 * 1000
const T0 = new Date(2026, 10, 9, 12, 0, 0).getTime() // 09.11.2026, lokale Mittagszeit

const hash = (char) => `sha256:${char.repeat(64)}`
const lib = (libraryId, section, prefix, options = {}) =>
  makeSyntheticLibrary({
    libraryId,
    learningSectionId: section,
    idPrefix: prefix,
    questionLabel: `${libraryId} Frage`,
    count: 4,
    activeQuestionIndexHash: hash(libraryId.length.toString(16).slice(-1)),
    ...options,
  })
const LIB_A = lib('lib-refresh-a', 'la01', 'sec-a01')
const LIB_B = lib('lib-refresh-b', 'la02', 'sec-a02')
const file = (data, name) => ({ name: name ?? `${data.libraryId}.json`, data })
const files = () => [file(LIB_A), file(LIB_B)]

beforeEach(() => {
  resetBrowserStorage()
  setNow(T0)
})

afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
  delete globalThis.navigator.storage
})

const setNow = (ms) => vi.spyOn(Date, 'now').mockReturnValue(ms)
const revisedLibA = () =>
  lib('lib-refresh-a', 'la01', 'sec-a01', {
    libraryVersion: '1.1.0',
    activeQuestionIndexHash: hash('e'), // anderer Hash als LIB_A (13 Zeichen -> 'd'): erzwingt die bestätigungspflichtige Aktualisierung
    contentRevisions: { [LIB_A.questions[1].id]: 2 },
  })
const confirmPending = async (container) => {
  const button = [...container.querySelectorAll('.import-problems button')].find((candidate) => candidate.textContent.trim() === 'Aktualisierung übernehmen')

  button.click()
  await vi.waitFor(() => expect(container.querySelector('.import-problems')).toBeNull())
  await settle(40)
}
const notice = (container) => container.querySelector('.library-refresh-notice')
const text = (node) => node.textContent.replace(/\s+/g, ' ').trim()
const clickIn = (container, name) => container.querySelector(`[data-refresh="${name}"]`).click()
const stored = () => withStore((store) => store.getLastLibraryImportAt())

async function importedApp(importFileList = files()) {
  const app = mountApp()

  await importFiles(app.container, importFileList)
  await vi.waitFor(() => expect(sectionCards(app.container).length).toBeGreaterThan(0))
  await settle(20)

  return app
}

// Zeit läuft weiter, die App wird ohne erneute Dateiauswahl neu gestartet (Katalog aus dem lokalen Speicher).
async function restartAfter(app, days) {
  setNow(T0 + days * DAY)
  const next = await reloadWithoutImport(app)

  await vi.waitFor(() => expect(sectionCards(next.container).length).toBeGreaterThan(0))
  await settle(40)

  return next
}

async function writeTimestamp(value, origin = 'import') {
  await new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME)

    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction('meta', 'readwrite')

      transaction.objectStore('meta').put({ key: 'lastSuccessfulLibraryImportAt', value, origin })
      transaction.oncomplete = () => {
        database.close()
        resolve()
      }
      transaction.onerror = () => reject(transaction.error)
    }
  })
}

async function deleteTimestampKey() {
  await new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME)

    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction('meta', 'readwrite')

      transaction.objectStore('meta').delete('lastSuccessfulLibraryImportAt')
      transaction.oncomplete = () => {
        database.close()
        resolve()
      }
      transaction.onerror = () => reject(transaction.error)
    }
  })
}

describe('30-day rule in the app', () => {
  it('A: shows no notice 29 days after the import, but the last-updated status', async () => {
    const first = await importedApp()

    expect(notice(first.container)).toBeNull()

    const { container } = await restartAfter(first, 29)

    expect(notice(container)).toBeNull()
    expect(text(container.querySelector('.import-last-updated'))).toBe('Zuletzt aktualisiert: 09.11.2026')
  })

  it('B: shows the notice exactly 30 days after the import', async () => {
    const { container } = await restartAfter(await importedApp(), 30)

    expect(notice(container)).not.toBeNull()
    expect(text(notice(container).querySelector('h2'))).toBe('Bibliotheken aktualisieren empfohlen')
    expect(text(notice(container))).toContain(
      'Deine Security+-Bibliotheken wurden zuletzt vor 30 Tagen aktualisiert. Du kannst weiterlernen oder jetzt prüfen, ob neuere Dateien verfügbar sind.',
    )
    expect(text(container.querySelector('[data-refresh="update"]'))).toBe('Jetzt aktualisieren')
    expect(text(container.querySelector('[data-refresh="later"]'))).toBe('Später')
  })

  it.each([31, 45, 400])('C: shows the notice %s days after the import', async (days) => {
    const { container } = await restartAfter(await importedApp(), days)

    expect(text(notice(container))).toContain(`vor ${days} Tagen`)
  })

  it('D: shows neither a notice nor a status without libraries and keeps the first-import flow', async () => {
    const app = mountApp()

    setNow(T0 + 90 * DAY)
    await settle(40)
    expect(notice(app.container)).toBeNull()
    expect(app.container.querySelector('.import-last-updated')).toBeNull()
    expect(app.container.textContent).toContain('Noch keine Lernbibliotheken importiert.')
    expect(app.container.querySelector('.import-button').textContent.trim()).toBe('JSON-Bibliotheken auswählen')
    expect(await stored()).toBeNull()
  })

  it('E: gives stored libraries without a timestamp a baseline instead of a notice (legacy state)', async () => {
    const first = await importedApp()

    await settle()
    unmountApp(first)
    await deleteTimestampKey()
    expect(await stored()).toBeNull()

    setNow(T0 + 200 * DAY)
    const second = mountApp()

    await vi.waitFor(() => expect(sectionCards(second.container).length).toBeGreaterThan(0))
    await settle(40)
    expect(notice(second.container)).toBeNull()
    expect(await stored()).toBe(T0 + 200 * DAY)
    expect(text(second.container.querySelector('.import-last-updated'))).toBe('Aktualisierungsdatum unbekannt')
    expect(second.container.textContent).not.toContain('Zuletzt aktualisiert')

    const day29 = await restartAfter(second, 229)

    expect(notice(day29.container)).toBeNull()
    expect(text(day29.container.querySelector('.import-last-updated'))).toBe('Aktualisierungsdatum unbekannt')
    expect(await stored()).toBe(T0 + 200 * DAY) // die Baseline bleibt über Reloads erhalten

    const day30 = await restartAfter(day29, 230)

    expect(notice(day30.container)).not.toBeNull()
    // Ehrlicher Text: kein Aktualisierungsdatum behauptet.
    expect(text(notice(day30.container))).toContain('Seit 30 Tagen ist keine Aktualisierung deiner Security+-Bibliotheken bekannt.')
    expect(text(notice(day30.container))).not.toContain('zuletzt vor')

    // Nach einem echten vollständigen Refresh wechselt der Status auf "Zuletzt aktualisiert".
    await importFiles(day30.container, files())
    await settle(40)
    expect(notice(day30.container)).toBeNull()
    expect(text(day30.container.querySelector('.import-last-updated'))).toBe('Zuletzt aktualisiert: 27.06.2027')

    const reloaded = await restartAfter(day30, 231)

    expect(text(reloaded.container.querySelector('.import-last-updated'))).toBe('Zuletzt aktualisiert: 27.06.2027')
  })

  it('I: keeps the timestamp across reloads', async () => {
    let app = await importedApp()

    expect(await stored()).toBe(T0)

    for (const days of [1, 5, 20]) {
      app = await restartAfter(app, days)
      expect(await stored()).toBe(T0)
    }

    expect(text(app.container.querySelector('.import-last-updated'))).toBe('Zuletzt aktualisiert: 09.11.2026')
  })
})

describe('"Später" and "Jetzt aktualisieren"', () => {
  it('F: "Später" hides the notice for this session and learning stays possible', async () => {
    const { container } = await restartAfter(await importedApp(), 31)

    clickIn(container, 'later')
    await settle(20)
    expect(notice(container)).toBeNull()
    expect(await stored()).toBe(T0)
    await openSection(container, 'Lernabschnitt 1')
    await startQuiz(container)
    expect(heading(container)).not.toBeNull()
  })

  it('F2: "Später" is only for the session: the notice returns after a restart while 30 days are still over', async () => {
    const first = await restartAfter(await importedApp(), 31)

    clickIn(first.container, 'later')
    await settle(20)

    const second = await restartAfter(first, 31)

    expect(notice(second.container)).not.toBeNull()
  })

  it('G: "Jetzt aktualisieren" opens the existing file picker and does not import anything itself', async () => {
    const { container } = await restartAfter(await importedApp(), 31)
    const input = container.querySelector('input[type="file"]')
    const spy = vi.spyOn(input, 'click').mockImplementation(() => {})
    const before = JSON.stringify(await withStore((store) => store.listLibraryStates()))

    clickIn(container, 'update')
    await settle(20)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(input.hasAttribute('multiple')).toBe(true)
    // Ohne Dateiauswahl ändert sich nichts: Hinweis bleibt, Zeitpunkt und Libraries bleiben.
    expect(notice(container)).not.toBeNull()
    expect(await stored()).toBe(T0)
    expect(JSON.stringify(await withStore((store) => store.listLibraryStates()))).toBe(before)
    expect(container.querySelector('.import-report')).toBeNull()
  })

  it('H: a successful re-import renews the timestamp, removes the notice and restarts the 30 days', async () => {
    const first = await restartAfter(await importedApp(), 31)

    expect(notice(first.container)).not.toBeNull()
    await importFiles(first.container, files())
    await settle(40)
    expect(await stored()).toBe(T0 + 31 * DAY)
    expect(notice(first.container)).toBeNull()
    expect(text(first.container.querySelector('.import-last-updated'))).toBe('Zuletzt aktualisiert: 10.12.2026')

    const day60 = await restartAfter(first, 60)

    expect(notice(day60.container)).toBeNull()

    const day61 = await restartAfter(day60, 61)

    expect(notice(day61.container)).not.toBeNull()
  })

  it('H2: a failed import does not renew the timestamp and the notice stays', async () => {
    const { container } = await restartAfter(await importedApp(), 31)

    await importFiles(container, [{ name: 'kaputt.json', raw: '{ kein json' }])
    await settle(40)
    expect(await stored()).toBe(T0)
    expect(notice(container)).not.toBeNull()
  })

  it('H3: a confirmed update of one library (partial batch) does not renew the global timestamp', async () => {
    const first = await restartAfter(await importedApp(), 31)
    const revised = revisedLibA()

    await importFiles(first.container, [file(revised, 'lib-refresh-a-v110.json')])
    await settle(40)
    expect(await stored()).toBe(T0)
    expect(notice(first.container)).not.toBeNull()

    await confirmPending(first.container)
    expect(await stored()).toBe(T0)
    expect(notice(first.container)).not.toBeNull()
  })

  it('H4: a complete batch with a pending update renews only once the update was confirmed', async () => {
    const first = await restartAfter(await importedApp(), 31)

    await importFiles(first.container, [file(revisedLibA(), 'lib-refresh-a-v110.json'), file(LIB_B)])
    await settle(40)
    expect(await stored()).toBe(T0)
    expect(text(first.container.querySelector('.import-problems-title'))).toBe('⚠ 1 Datei benötigt Aufmerksamkeit')
    expect(notice(first.container)).not.toBeNull()

    await confirmPending(first.container)
    expect(await stored()).toBe(T0 + 31 * DAY)
    expect(notice(first.container)).toBeNull()
  })
})

describe('partial and unclean imports keep the global timestamp (Fix 1)', () => {
  const THREE = [LIB_A, LIB_B, lib('lib-refresh-c', 'la03', 'sec-a03')]
  const threeFiles = (count = 3, extra = []) => [...THREE.slice(0, count).map((data) => file(data)), ...extra]

  it.each([
    [1, 'known library only'],
    [2, 'two of three known libraries'],
  ])('%s of 3 stored: unchanged, notice stays', async (count) => {
    const first = await restartAfter(await importedApp(threeFiles()), 31)

    await importFiles(first.container, threeFiles(count))
    await settle(40)
    expect(await stored()).toBe(T0)
    expect(notice(first.container)).not.toBeNull()
    expect(first.container.querySelector('.import-success')).not.toBeNull() // der Import selbst war erfolgreich
  })

  it('3 of 3 clean: renewed', async () => {
    const first = await restartAfter(await importedApp(threeFiles()), 31)

    await importFiles(first.container, threeFiles())
    await settle(40)
    expect(await stored()).toBe(T0 + 31 * DAY)
    expect(notice(first.container)).toBeNull()
  })

  it('3 of 3 plus a broken file: unchanged, notice stays and the error is shown', async () => {
    const first = await restartAfter(await importedApp(threeFiles()), 31)

    await importFiles(first.container, threeFiles(3, [{ name: 'kaputt.json', raw: '{ kein json' }]))
    await settle(40)
    expect(await stored()).toBe(T0)
    expect(notice(first.container)).not.toBeNull()
    expect(first.container.querySelector('.import-problems')).not.toBeNull()
  })

  it('2 clean plus a broken file when 3 are stored: unchanged', async () => {
    const first = await restartAfter(await importedApp(threeFiles()), 31)

    await importFiles(first.container, threeFiles(2, [{ name: 'kaputt.json', raw: '{ kein json' }]))
    await settle(40)
    expect(await stored()).toBe(T0)
  })

  it('a partial import still keeps the data and still asks for persistent storage', async () => {
    Object.defineProperty(globalThis.navigator, 'storage', {
      value: { persisted: vi.fn().mockResolvedValue(false), persist: vi.fn().mockResolvedValue(true) },
      configurable: true,
    })

    const first = await restartAfter(await importedApp(threeFiles()), 31)
    const calls = globalThis.navigator.storage.persist.mock.calls.length

    await importFiles(first.container, threeFiles(1))
    await settle(40)
    expect(globalThis.navigator.storage.persist.mock.calls.length).toBe(calls + 1)
    expect(await stored()).toBe(T0)
  })
})

describe('timestamp in the future (Fix 3)', () => {
  it.each([
    ['exactly one millisecond ahead', 1],
    ['one minute ahead', 60 * 1000],
    ['one day ahead', DAY],
    ['one year ahead', 365 * DAY],
  ])('%s: no crash, no deletion, new baseline from now, no reminder, honest status', async (_label, ahead) => {
    const first = await importedApp()

    await settle()
    unmountApp(first)
    await writeTimestamp(T0 + ahead, 'import')

    const second = mountApp()

    await vi.waitFor(() => expect(sectionCards(second.container).length).toBe(2))
    await settle(40)
    expect(notice(second.container)).toBeNull()
    expect(await stored()).toBe(T0)
    expect(text(second.container.querySelector('.import-last-updated'))).toBe('Aktualisierungsdatum unbekannt')
    expect(second.container.querySelector('.library-message-warning')).toBeNull()

    // Danach läuft die Erinnerung ab der neuen Baseline: kein dauerhaft unterdrückter Hinweis.
    const day30 = await restartAfter(second, 30)

    expect(notice(day30.container)).not.toBeNull()
  })

  it('keeps libraries, progress, resume and exam attempts untouched', async () => {
    const examLibraries = makeExamLibraryData({ la01: 40, la02: 60, la03: 30 })
    const app = await importedApp(examLibraries.map((data, index) => ({ name: `exam-${index}.json`, data })))
    const allQuestions = { questions: examLibraries.flatMap((data) => data.questions) }

    await openSection(app.container, 'Lernabschnitt 1')
    await startQuiz(app.container)
    await answerCurrent(app.container, allQuestions, { correct: true })
    await settle(60)

    const headingBefore = heading(app.container)
    const core = async () =>
      JSON.stringify(
        await withStore(async (store) => [await store.listLibraryStates(), await store.listAllProgress(), await store.listExamAttempts(), await store.getActiveExamAttempt()]),
      )
    const before = await core()

    unmountApp(app)
    await writeTimestamp(T0 + DAY, 'import')

    const later = mountApp()

    await vi.waitFor(() => expect(sectionCards(later.container).length).toBe(3))
    await settle(40)
    expect(await core()).toBe(before)
    expect(later.container.querySelector('.exam-entry')).not.toBeNull()
    await openSection(later.container, 'Lernabschnitt 1')
    await resume(later.container)
    expect(heading(later.container)).toBe(headingBefore)
    expect(await core()).toBe(before)
  })
})

describe('nothing is reset after 30 days', () => {
  it('J/K/L: libraries, progress, resume and exam attempts stay unchanged while the notice is shown', async () => {
    const examLibraries = makeExamLibraryData({ la01: 40, la02: 60, la03: 30 })
    const examFiles = examLibraries.map((data, index) => ({ name: `exam-${index}.json`, data }))
    const app = await importedApp(examFiles)
    const allQuestions = { questions: examLibraries.flatMap((data) => data.questions) }

    // Lernrunde mit einer Antwort in la01 (Resume-Stand).
    await openSection(app.container, 'Lernabschnitt 1')
    await startQuiz(app.container)
    const answeredId = await answerCurrent(app.container, allQuestions, { correct: true })

    await settle(60)

    const headingBefore = heading(app.container)
    const core = async () =>
      JSON.stringify(
        await withStore(async (store) => [await store.listLibraryStates(), await store.listAllProgress(), await store.listExamAttempts(), await store.getActiveExamAttempt()]),
      )
    const roundOrder = () => withStore(async (store) => (await store.getLatestSectionSession('la01')).orderedQuestionIds)
    const before = await core()
    const orderBefore = await roundOrder()

    expect(before).toContain(answeredId)

    const later = await restartAfter(app, 45)

    expect(notice(later.container)).not.toBeNull()
    expect(await core()).toBe(before)
    expect(await roundOrder()).toEqual(orderBefore)
    expect(sectionCards(later.container)).toHaveLength(3)
    expect(later.container.querySelector('.exam-entry')).not.toBeNull()

    // Weiterlernen und Resume sind trotz Hinweis möglich: gleiche Frage, gleiche Reihenfolge, Fortschritt unverändert.
    clickIn(later.container, 'later')
    await settle(20)
    await openSection(later.container, 'Lernabschnitt 1')
    await resume(later.container)
    expect(heading(later.container)).toBe(headingBefore)
    expect(await core()).toBe(before)
    expect(await roundOrder()).toEqual(orderBefore)
  })

  it('L2: an active exam attempt survives the notice and the exam stays reachable', async () => {
    const examLibraries = makeExamLibraryData({ la01: 40, la02: 60, la03: 30 })
    const app = await importedApp(examLibraries.map((data, index) => ({ name: `exam-${index}.json`, data })))

    app.container.querySelector('[data-exam="open"]').click()
    await vi.waitFor(() => expect(app.container.querySelector('[data-exam="start"]')).not.toBeNull())
    app.container.querySelector('[data-exam="start"]').click()
    await vi.waitFor(() => expect(app.container.querySelector('.exam-card')).not.toBeNull())
    await settle(40)

    const attempts = async () => JSON.stringify(await withStore(async (store) => [await store.listExamAttempts(), await store.getActiveExamAttempt()]))
    const before = await attempts()

    expect(before).toContain('"inProgress"')

    const later = await restartAfter(app, 60)

    expect(notice(later.container)).not.toBeNull()
    expect(await attempts()).toBe(before)
    expect(later.container.querySelector('.exam-entry')).not.toBeNull()
    expect(later.container.querySelector('[data-exam="open"]')).not.toBeNull()
  })
})

describe('storage persistence (best effort)', () => {
  const storageMock = (overrides = {}) => {
    const storage = { persisted: vi.fn().mockResolvedValue(false), persist: vi.fn().mockResolvedValue(true), ...overrides }

    Object.defineProperty(globalThis.navigator, 'storage', { value: storage, configurable: true })

    return storage
  }

  it('asks the browser once after a successful import, never on start or after a failed import', async () => {
    const storage = storageMock()
    const app = await importedApp()

    expect(storage.persist).toHaveBeenCalledTimes(1)

    const later = await restartAfter(app, 5)

    expect(storage.persist).toHaveBeenCalledTimes(1)
    await importFiles(later.container, [{ name: 'kaputt.json', raw: '{ kein json' }])
    await settle(20)
    expect(storage.persist).toHaveBeenCalledTimes(1)
  })

  it('works without browser support and when the request fails or is refused', async () => {
    const plain = await importedApp()

    expect(plain.container.querySelector('.import-report')).not.toBeNull()
    expect(await stored()).toBe(T0)

    unmountAll()
    resetBrowserStorage()
    storageMock({ persist: vi.fn().mockRejectedValue(new Error('denied')) })

    const failing = await importedApp()

    expect(failing.container.querySelector('.import-report')).not.toBeNull()
    expect(failing.container.querySelector('.library-message-warning')).toBeNull()
    expect(await stored()).toBe(T0)
  })
})

describe('English', () => {
  it('M: shows every new text in English and switches back', async () => {
    const { container } = await restartAfter(await importedApp(), 31)

    await switchLanguage(container, 'en')
    expect(text(notice(container).querySelector('h2'))).toBe('Library update recommended')
    expect(text(notice(container))).toContain(
      'Your Security+ libraries were last updated 31 days ago. You can keep learning or check now whether newer files are available.',
    )
    expect(text(container.querySelector('[data-refresh="update"]'))).toBe('Update now')
    expect(text(container.querySelector('[data-refresh="later"]'))).toBe('Later')
    expect(text(container.querySelector('.import-last-updated'))).toBe('Last updated: Nov 9, 2026')

    await switchLanguage(container, 'de')
    expect(text(notice(container).querySelector('h2'))).toBe('Bibliotheken aktualisieren empfohlen')
    expect(text(container.querySelector('.import-last-updated'))).toBe('Zuletzt aktualisiert: 09.11.2026')
  })

  it('M3: the baseline status and the unknown-date notice are English too', async () => {
    const first = await importedApp()

    await settle()
    unmountApp(first)
    await deleteTimestampKey()
    setNow(T0 + 10 * DAY)

    const baseline = mountApp()

    await vi.waitFor(() => expect(sectionCards(baseline.container).length).toBe(2))
    await settle(40)
    await switchLanguage(baseline.container, 'en')
    expect(text(baseline.container.querySelector('.import-last-updated'))).toBe('Update date unknown')

    const due = await restartAfter(baseline, 40)

    await switchLanguage(due.container, 'en')
    expect(text(notice(due.container))).toContain('No update of your Security+ libraries has been recorded for 30 days.')
    expect(text(due.container.querySelector('.import-last-updated'))).toBe('Update date unknown')
  })

  it('M2: "Later" works in English too', async () => {
    const { container } = await restartAfter(await importedApp(), 31)

    await switchLanguage(container, 'en')
    clickIn(container, 'later')
    await settle(20)
    expect(notice(container)).toBeNull()
  })
})

describe('accessibility', () => {
  it('N (structure): the notice is a labelled region whose actions are real buttons', async () => {
    const { container } = await restartAfter(await importedApp(), 31)
    const region = notice(container)

    expect(region.tagName).toBe('SECTION')
    expect(region.getAttribute('aria-label')).toBe('Bibliotheken aktualisieren empfohlen')
    expect([...region.querySelectorAll('button')].map((button) => button.type)).toEqual(['button', 'button'])
    // Nicht-blockierend: kein Dialog, kein Overlay.
    expect(container.querySelector('[role="dialog"], [aria-modal="true"]')).toBeNull()
  })
})
