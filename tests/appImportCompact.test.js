// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  importFiles,
  mountApp,
  reloadWithoutImport,
  resetBrowserStorage,
  sectionCards,
  settle,
  switchLanguage,
  visibleText,
  unmountAll,
  withStore,
} from './helpers/appHarness.js'
import { makeSyntheticLibrary } from './fixtures/syntheticLibrary.js'

// Kompakte Import-Ergebnisanzeige: Erfolg kompakt, Details einklappbar, Fehler prominent. Nur Darstellung.
beforeEach(resetBrowserStorage)
afterEach(unmountAll)

const hash = (char) => `sha256:${char.repeat(64)}`
const lib = (libraryId, section, prefix, options = {}) =>
  makeSyntheticLibrary({
    libraryId,
    learningSectionId: section,
    idPrefix: prefix,
    questionLabel: `${libraryId} Frage`,
    count: 3,
    english: 'all',
    activeQuestionIndexHash: hash(libraryId.length.toString(16).slice(-1)),
    ...options,
  })
const file = (data, name) => ({ name: name ?? `${data.libraryId}.json`, data })

// la01: 2 Libraries (3 + 2 Fragen), la02: 1 Library (3), la08: 2 Libraries (3 + 4). Gesamt 5 Libraries, 15 Fragen.
const LIBRARIES = [
  lib('lib-one-a', 'la01', 'sec-a01'),
  lib('lib-one-b', 'la01', 'sec-a51', { count: 2 }),
  lib('lib-two', 'la02', 'sec-a02'),
  lib('lib-eight-a', 'la08', 'sec-a08'),
  lib('lib-eight-b', 'la08', 'sec-a58', { count: 4 }),
]
const allFiles = () => LIBRARIES.map((data) => file(data))

const text = (node) => node.textContent.replace(/\s+/g, ' ').trim()
const toggle = (container, kind) => container.querySelector(`[data-import="${kind}-toggle"]`)
const panel = (container, kind) => container.querySelector(`[data-import="${kind}"]`)
const rowFor = (container, name) => [...panel(container, 'files').querySelectorAll('li')].find((row) => row.textContent.includes(name))
const isShown = (node) => node !== null && node.closest('[hidden]') === null

async function importAll() {
  const app = mountApp()

  await importFiles(app.container, allFiles())

  return app
}

describe('compact import success', () => {
  it('shows only the compact summary after a fully successful import and keeps the details closed', async () => {
    const { container } = await importAll()
    const report = container.querySelector('.import-report')

    expect(text(report.querySelector('.import-success'))).toBe('✓ Import erfolgreich')
    expect(report.querySelector('.import-summary').textContent).toBe(
      '5 Dateien geprüft · 5 Libraries erkannt · 3 Lernabschnitte · 15 aktive Fragen',
    )
    expect(text(report.querySelector('.import-languages'))).toBe('Deutsch ✓ · English ✓')
    expect(toggle(container, 'details').textContent.trim()).toBe('Importdetails anzeigen')
    expect(toggle(container, 'details').getAttribute('aria-expanded')).toBe('false')
    expect(isShown(panel(container, 'details'))).toBe(false)
    expect(isShown(panel(container, 'files'))).toBe(false)
    expect(report.querySelector('.import-problems')).toBeNull()
    expect(report.querySelector('.library-message-error')).toBeNull()
    // Lernabschnitte sind direkt erreichbar.
    expect(sectionCards(container)).toHaveLength(3)
    expect(report.compareDocumentPosition(sectionCards(container)[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('opens and closes the details with a per-section summary and reveals the file list only after a second disclosure', async () => {
    const { container } = await importAll()
    const details = toggle(container, 'details')

    details.click()
    await settle(20)

    expect(details.textContent.trim()).toBe('Importdetails ausblenden')
    expect(details.getAttribute('aria-expanded')).toBe('true')
    expect(details.getAttribute('aria-controls')).toBe(panel(container, 'details').id)
    expect(isShown(panel(container, 'details'))).toBe(true)
    expect([...container.querySelectorAll('.import-section-row')].map(text)).toEqual([
      '✓ Lernabschnitt 1 · 2 Libraries · 5 Fragen',
      '✓ Lernabschnitt 2 · 1 Library · 3 Fragen',
      '✓ Lernabschnitt 8 · 2 Libraries · 7 Fragen',
    ])
    expect(isShown(panel(container, 'files'))).toBe(false)

    const files = toggle(container, 'files')

    expect(files.textContent.trim()).toBe('Alle 5 Dateien anzeigen')
    expect(files.getAttribute('aria-expanded')).toBe('false')
    expect(files.getAttribute('aria-controls')).toBe(panel(container, 'files').id)

    files.click()
    await settle(20)

    expect(files.textContent.trim()).toBe('Dateien ausblenden')
    expect(files.getAttribute('aria-expanded')).toBe('true')
    expect(isShown(panel(container, 'files'))).toBe(true)

    const rows = [...panel(container, 'files').querySelectorAll('li')]

    expect(rows).toHaveLength(5)
    expect(rowFor(container, 'lib-one-a.json').textContent).toBe('✓lib-one-a.jsonNeu importiert · 3 Fragen · EN vollständig')
    expect(rowFor(container, 'lib-eight-b.json').textContent).toContain('Neu importiert · 4 Fragen · EN vollständig')
    expect(rows.every((row) => !row.querySelector('.library-message'))).toBe(true)

    files.click()
    await settle(20)
    expect(isShown(panel(container, 'files'))).toBe(false)
    expect(files.getAttribute('aria-expanded')).toBe('false')

    details.click()
    await settle(20)
    expect(isShown(panel(container, 'details'))).toBe(false)
    expect(details.getAttribute('aria-expanded')).toBe('false')
    expect(details.textContent.trim()).toBe('Importdetails anzeigen')
  })

  it('names incomplete English with numbers instead of a checkmark', async () => {
    const app = mountApp()

    await importFiles(app.container, [file(lib('lib-en', 'la01', 'sec-a01')), file(lib('lib-de', 'la02', 'sec-a02', { english: 'none' }))])

    expect(text(app.container.querySelector('.import-languages'))).toBe('Deutsch ✓ · EN: 3 von 6 Fragen')
    toggle(app.container, 'details').click()
    toggle(app.container, 'files').click()
    await settle(20)

    expect(rowFor(app.container, 'lib-en.json').textContent).toContain('Neu importiert · 3 Fragen · EN vollständig')
    expect(rowFor(app.container, 'lib-de.json').textContent).toContain('Neu importiert · 3 Fragen')
    expect(rowFor(app.container, 'lib-de.json').textContent).not.toContain('EN')
  })

  it('keeps the libraries, the overview and the stored data after a reload and shows no report again', async () => {
    const first = await importAll()
    const before = await withStore((store) => store.listLibraryStates())
    const second = await reloadWithoutImport(first)

    await settle()
    expect(second.container.querySelector('.import-report')).toBeNull()
    expect(sectionCards(second.container)).toHaveLength(3)
    expect(second.container.querySelector('.exam-entry')).not.toBeNull()
    expect(await withStore((store) => store.listLibraryStates())).toEqual(before)
  })
})

describe('errors stay prominent', () => {
  it('shows failed files outside of any closed disclosure, with file name and reason, next to the compact success', async () => {
    const app = mountApp()

    await importFiles(app.container, [
      file(LIBRARIES[0]),
      { name: 'kaputt.json', raw: '{ das ist kein json' },
      file(LIBRARIES[2]),
      file(LIBRARIES[2], 'lib-two-kopie.json'),
    ])

    const problems = app.container.querySelector('.import-problems')

    expect(isShown(problems)).toBe(true)
    expect(problems.getAttribute('role')).toBe('alert')
    expect(text(problems.querySelector('.import-problems-title'))).toBe('⚠ 2 Dateien konnten nicht importiert werden')

    const items = [...problems.querySelectorAll('li')]

    expect(items).toHaveLength(2)
    expect(items.every((item) => isShown(item) && item.classList.contains('library-message-error'))).toBe(true)
    expect(text(items[0])).toContain('kaputt.json')
    expect(text(items[0])).toContain('Ungültig')
    expect(text(items[0])).toContain('Grund:')
    expect(text(items[1])).toContain('lib-two-kopie.json')
    expect(text(items[1])).toContain('Übersprungen')
    expect(text(app.container.querySelector('.import-success'))).toBe('✓ Import teilweise erfolgreich')
    expect(app.container.querySelector('.import-summary').textContent).toContain('4 Dateien geprüft · 2 Libraries erkannt · 2 Lernabschnitte')
    expect(sectionCards(app.container)).toHaveLength(2)
  })

  it('uses the singular for a single failed file and no success line when nothing could be imported', async () => {
    const app = mountApp()

    await importFiles(app.container, [{ name: 'kaputt.json', raw: '{ das ist kein json' }])

    const report = app.container.querySelector('.import-report')

    expect(text(report.querySelector('.import-problems-title'))).toBe('⚠ 1 Datei konnte nicht importiert werden')
    expect(isShown(report.querySelector('.import-problems'))).toBe(true)
    expect(report.querySelector('.import-success')).toBeNull()
    expect(toggle(app.container, 'details')).toBeNull()
  })

  it('keeps a pending update prominent with its confirm button and shows the result compactly after confirming', async () => {
    const original = lib('lib-up', 'la01', 'sec-a01', { count: 4 })
    const first = mountApp()

    await importFiles(first.container, [file(original)])

    const revised = lib('lib-up', 'la01', 'sec-a01', {
      count: 4,
      libraryVersion: '1.1.0',
      activeQuestionIndexHash: hash('d'),
      contentRevisions: { [original.questions[1].id]: 2 },
    })
    const second = await reloadWithoutImport(first)

    await importFiles(second.container, [file(revised, 'lib-up-v110.json')])

    const problems = second.container.querySelector('.import-problems')

    expect(isShown(problems)).toBe(true)
    expect(text(problems.querySelector('.import-problems-title'))).toBe('⚠ 1 Datei benötigt Aufmerksamkeit')
    expect(text(problems)).toContain('lib-up-v110.json')

    const confirm = [...problems.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Aktualisierung übernehmen')

    expect(confirm).toBeDefined()
    confirm.click()
    await vi.waitFor(() => expect(second.container.querySelector('.import-problems')).toBeNull())
    await settle()
    expect(second.container.querySelector('.import-report').textContent).toContain('Aktualisiert')
    expect(text(second.container.querySelector('.import-success'))).toBe('✓ Import erfolgreich')
  })
})

describe('singular and plural', () => {
  it('uses the singular for one library, one learning section, one question and one file (DE)', async () => {
    const app = mountApp()

    await importFiles(app.container, [file(lib('lib-solo', 'la01', 'sec-a01', { count: 1 }))])
    await settle()

    expect(app.container.querySelector('.import-summary').textContent).toBe('1 Datei geprüft · 1 Library erkannt · 1 Lernabschnitt · 1 aktive Frage')

    const files = toggle(app.container, 'details')

    files.click()
    await settle(20)
    expect(toggle(app.container, 'files').textContent.trim()).toBe('Datei anzeigen')
    expect(text(app.container.querySelector('.import-section-row'))).toBe('✓ Lernabschnitt 1 · 1 Library · 1 Frage')
  })

  it('uses the singular for one library, one learning section, one question and one file (EN)', async () => {
    const app = mountApp()

    await settle()
    await switchLanguage(app.container, 'en')
    await importFiles(app.container, [file(lib('lib-solo', 'la01', 'sec-a01', { count: 1 }))])
    await settle()

    expect(app.container.querySelector('.import-summary').textContent).toBe('1 file checked · 1 library recognised · 1 learning section · 1 active question')
    toggle(app.container, 'details').click()
    await settle(20)
    expect(toggle(app.container, 'files').textContent.trim()).toBe('Show file')
    expect(text(app.container.querySelector('.import-section-row'))).toBe('✓ Learning section 1 · 1 library · 1 question')
  })

  it('keeps plural forms and the thousands separator for larger numbers', async () => {
    const app = mountApp()

    await importFiles(app.container, [file(lib('lib-big', 'la01', 'sec-a01', { count: 1200 })), file(lib('lib-two', 'la02', 'sec-a02'))])
    await settle()

    expect(app.container.querySelector('.import-summary').textContent).toBe('2 Dateien geprüft · 2 Libraries erkannt · 2 Lernabschnitte · 1.203 aktive Fragen')
  })

  it('words one and several failed files correctly (DE and EN)', async () => {
    const app = mountApp()

    await importFiles(app.container, [{ name: 'kaputt.json', raw: '{ kein json' }])
    expect(text(app.container.querySelector('.import-problems-title'))).toBe('⚠ 1 Datei konnte nicht importiert werden')
    await switchLanguage(app.container, 'en')
    expect(text(app.container.querySelector('.import-problems-title'))).toBe('⚠ 1 file could not be imported')

    await switchLanguage(app.container, 'de')
    await importFiles(app.container, [{ name: 'a.json', raw: '{ x' }, { name: 'b.json', raw: '{ y' }])
    expect(text(app.container.querySelector('.import-problems-title'))).toBe('⚠ 2 Dateien konnten nicht importiert werden')
    await switchLanguage(app.container, 'en')
    expect(text(app.container.querySelector('.import-problems-title'))).toBe('⚠ 2 files could not be imported')
  })

  it('words a pending update neutrally in English', async () => {
    const original = lib('lib-up', 'la01', 'sec-a01', { count: 4 })
    const first = mountApp()

    await importFiles(first.container, [file(original)])

    const revised = lib('lib-up', 'la01', 'sec-a01', {
      count: 4,
      libraryVersion: '1.1.0',
      activeQuestionIndexHash: hash('d'),
      contentRevisions: { [original.questions[1].id]: 2 },
    })
    const second = await reloadWithoutImport(first)

    await switchLanguage(second.container, 'en')
    await importFiles(second.container, [file(revised, 'lib-up-v110.json')])
    expect(text(second.container.querySelector('.import-problems-title'))).toBe('⚠ 1 file needs attention')
  })
})

describe('hidden DOM does not count as visible', () => {
  it('finds file names and statuses in the DOM but not in the visible text while the disclosures are closed', async () => {
    const { container } = await importAll()
    const report = container.querySelector('.import-report')

    expect(report.textContent).toContain('lib-one-a.json')
    expect(report.textContent).toContain('Neu importiert')
    expect(visibleText(report)).not.toContain('lib-one-a.json')
    expect(visibleText(report)).not.toContain('Neu importiert')
    expect(visibleText(report)).toContain('Import erfolgreich')

    toggle(container, 'details').click()
    await settle(20)
    expect(visibleText(report)).toContain('Lernabschnitt 1 · 2 Libraries · 5 Fragen')
    expect(visibleText(report)).not.toContain('lib-one-a.json')

    toggle(container, 'files').click()
    await settle(20)
    expect(visibleText(report)).toContain('lib-one-a.json')
    expect(visibleText(report)).toContain('Neu importiert')

    toggle(container, 'files').click()
    await settle(20)
    expect(visibleText(report)).not.toContain('lib-one-a.json')
  })
})

describe('English', () => {
  it('translates every new text and switches back without losing the open state', async () => {
    const { container } = mountApp()

    await settle()
    await switchLanguage(container, 'en')
    await importFiles(container, [...allFiles(), { name: 'kaputt.json', raw: '{ not json' }])

    const report = container.querySelector('.import-report')

    expect(text(report.querySelector('.import-problems-title'))).toBe('⚠ 1 file could not be imported')
    expect(text(report.querySelector('.import-problems li'))).toContain('Reason:')
    expect(text(report.querySelector('.import-success'))).toBe('✓ Import partially successful')
    expect(text(report.querySelector('.import-languages'))).toBe('German ✓ · English ✓')
    expect(toggle(container, 'details').textContent.trim()).toBe('Show import details')

    toggle(container, 'details').click()
    await settle(20)
    expect(toggle(container, 'details').textContent.trim()).toBe('Hide import details')
    expect([...container.querySelectorAll('.import-section-row')].map(text)).toEqual([
      '✓ Learning section 1 · 2 libraries · 5 questions',
      '✓ Learning section 2 · 1 library · 3 questions',
      '✓ Learning section 8 · 2 libraries · 7 questions',
    ])
    expect(toggle(container, 'files').textContent.trim()).toBe('Show all 6 files')

    toggle(container, 'files').click()
    await settle(20)
    expect(toggle(container, 'files').textContent.trim()).toBe('Hide files')
    expect(rowFor(container, 'lib-one-a.json').textContent).toContain('Newly imported · 3 questions · EN complete')
    expect(rowFor(container, 'kaputt.json').textContent).toContain('Invalid')

    await switchLanguage(container, 'de')
    expect(toggle(container, 'details').textContent.trim()).toBe('Importdetails ausblenden')
    expect(toggle(container, 'files').textContent.trim()).toBe('Dateien ausblenden')
    expect(isShown(panel(container, 'files'))).toBe(true)
    expect(text(container.querySelector('.import-problems-title'))).toBe('⚠ 1 Datei konnte nicht importiert werden')
  })

  it('shows the success texts in English for a clean import', async () => {
    const { container } = mountApp()

    await settle()
    await switchLanguage(container, 'en')
    await importFiles(container, allFiles())

    expect(text(container.querySelector('.import-success'))).toBe('✓ Import successful')
    expect(container.querySelector('.import-summary').textContent).toBe(
      '5 files checked · 5 libraries recognised · 3 learning sections · 15 active questions',
    )
  })
})
