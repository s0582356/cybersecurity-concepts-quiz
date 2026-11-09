// @vitest-environment jsdom
// Klick auf "Lernen"/"Weiterlernen" an einer Abschnittskarte: der nächste Schritt (Details, Sprachwahl, Start) steht weiter unten auf der
// Seite und muss ins Bild geholt und fokussiert werden. jsdom hat kein Layout; geprüft werden deshalb der Scroll-Aufruf
// (scrollIntoView, Ziel und Optionen), das Fokusziel und der unveränderte Zwei-Schritt-Ablauf (nichts startet automatisch).
import 'fake-indexeddb/auto'
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  answerCurrent,
  buttonByText,
  heading,
  importFiles,
  mountApp,
  next,
  reloadWithoutImport,
  resetBrowserStorage,
  sectionCard,
  sectionCards,
  settle,
  startQuiz,
  switchLanguage,
  unmountAll,
  withStore,
} from './helpers/appHarness.js'
import { makeSyntheticLibrary } from './fixtures/syntheticLibrary.js'

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
const LIB_ONE = lib('lib-nav-one', 'la01', 'sec-a01')
const LIB_TWO = lib('lib-nav-two', 'la02', 'sec-a02', { count: 4 })
const LIB_NINE = lib('lib-nav-nine', 'la09', 'sec-a09')
const file = (data) => ({ name: `${data.libraryId}.json`, data })
const ALL = [LIB_ONE, LIB_TWO, LIB_NINE]

let scrollIntoView

beforeEach(() => {
  resetBrowserStorage()
  // jsdom kennt scrollIntoView nicht: als Spy bereitstellen, damit Aufruf, Ziel (this) und Optionen prüfbar sind.
  scrollIntoView = vi.fn()
  Element.prototype.scrollIntoView = scrollIntoView
  delete window.matchMedia
})

afterEach(() => {
  unmountAll()
  delete Element.prototype.scrollIntoView
  delete window.matchMedia
  vi.restoreAllMocks()
})

const detail = (container) => container.querySelector('[aria-label="Lernabschnitt"], [aria-label="Learning section"]')
const cardButton = (container, label) => sectionCard(container, label).querySelector('button')
const text = (node) => node.textContent.replace(/\s+/g, ' ').trim()

// Gespeicherte Libraries, Reload ohne Import: genau der Zustand, in dem der Fehler gemeldet wurde.
async function storedApp(libraries = ALL) {
  const first = mountApp()

  await importFiles(first.container, libraries.map(file))
  await vi.waitFor(() => expect(sectionCards(first.container).length).toBe(libraries.length))

  const app = await reloadWithoutImport(first)

  await vi.waitFor(() => expect(sectionCards(app.container).length).toBe(libraries.length))
  await settle(40)
  scrollIntoView.mockClear()

  return app
}

async function clickCard(container, label) {
  cardButton(container, label).click()
  await vi.waitFor(() => expect(detail(container)?.textContent).toContain(label))
  await settle(20)
}

describe('"Lernen" brings the next step into view and focuses it', () => {
  it('saved libraries -> reload -> "Lernen": section is set, the detail is scrolled to, "Lernrunde starten" has focus', async () => {
    const { container } = await storedApp()

    expect(cardButton(container, 'Lernabschnitt 1').textContent.trim()).toBe('Lernen')
    expect(detail(container)).toBeNull()
    await clickCard(container, 'Lernabschnitt 1')

    // Abschnitt gesetzt
    expect(text(detail(container))).toContain('Lernabschnitt 1')
    expect(sectionCard(container, 'Lernabschnitt 1').classList.contains('section-card-selected')).toBe(true)
    // Scroll: genau einmal, auf die Detailsektion, weich
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(scrollIntoView.mock.contexts[0]).toBe(detail(container))
    expect(scrollIntoView.mock.calls[0][0]).toEqual({ behavior: 'smooth', block: 'start' })
    // Fokus: auf dem Startknopf, nicht verloren und nicht auf der Karte
    const start = buttonByText(container, 'Lernrunde starten')

    expect(start).toBeDefined()
    expect(document.activeElement).toBe(start)
    expect(document.activeElement).not.toBe(cardButton(container, 'Lernabschnitt 1'))
    // Zwei-Schritt-Ablauf: es startet nichts automatisch
    expect(container.querySelector('.question-card')).toBeNull()
    expect(await withStore((store) => store.getLatestSectionSession('la01'))).toBeNull()

    // Der fokussierte Knopf startet die echte Lernrunde.
    start.click()
    await vi.waitFor(() => expect(heading(container)).not.toBeNull())
  })

  it('scrolls and focuses for every section, also when another section was open before', async () => {
    const { container } = await storedApp()

    await clickCard(container, 'Lernabschnitt 2')
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(text(detail(container))).toContain('Lernabschnitt 2')
    expect(document.activeElement).toBe(buttonByText(container, 'Lernrunde starten'))

    await clickCard(container, 'Lernabschnitt 9')
    expect(scrollIntoView).toHaveBeenCalledTimes(2)
    expect(scrollIntoView.mock.contexts[1]).toBe(detail(container))
    expect(text(detail(container))).toContain('Lernabschnitt 9')
    expect(document.activeElement).toBe(buttonByText(container, 'Lernrunde starten'))
  })

  it('the focus target is a real, keyboard-reachable button inside the detail area', async () => {
    const { container } = await storedApp()

    await clickCard(container, 'Lernabschnitt 1')

    const active = document.activeElement

    expect(active.tagName).toBe('BUTTON')
    expect(active.disabled).toBe(false)
    expect(active.getAttribute('tabindex')).toBeNull() // kein künstlicher tabindex nötig
    expect(container.contains(active)).toBe(true)
    // Der Detailbereich (Ziel des Scrollens) liegt direkt vor den Startkontrollen.
    expect(detail(container).compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('English: same behaviour with the English labels', async () => {
    const { container } = await storedApp()

    await switchLanguage(container, 'en')
    scrollIntoView.mockClear()
    cardButton(container, 'Learning section 1').click()
    await vi.waitFor(() => expect(detail(container)?.textContent).toContain('Learning section 1'))
    await settle(20)
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(buttonByText(container, 'Start learning round'))
  })
})

describe('small screens: details and start button do not fit into one window', () => {
  // jsdom hat kein Layout: Positionen und Fensterhöhe werden vorgegeben (Details ab y=100, Startknopf endet bei y=1500).
  const withLayout = (innerHeight, startBottom) => {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(innerHeight)
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function rect() {
      if (this.hasAttribute?.('data-section-start')) {
        return { top: startBottom - 48, bottom: startBottom, left: 0, right: 0, width: 0, height: 48 }
      }

      return { top: this.getAttribute?.('aria-label') === 'Lernabschnitt' ? 100 : 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }
    })
  }

  it('scrolls the start button itself into the middle of the window and focuses it', async () => {
    const { container } = await storedApp()

    withLayout(800, 1500) // 1500 - 100 > 800: passt nicht
    await clickCard(container, 'Lernabschnitt 1')

    const start = buttonByText(container, 'Lernrunde starten')

    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(scrollIntoView.mock.contexts[0]).toBe(start)
    expect(scrollIntoView.mock.calls[0][0]).toEqual({ behavior: 'smooth', block: 'center' })
    expect(document.activeElement).toBe(start)
  })

  it('keeps the detail area as the target when everything fits into the window', async () => {
    const { container } = await storedApp()

    withLayout(800, 600) // 600 - 100 <= 800
    await clickCard(container, 'Lernabschnitt 1')
    expect(scrollIntoView.mock.contexts[0]).toBe(detail(container))
    expect(scrollIntoView.mock.calls[0][0]).toEqual({ behavior: 'smooth', block: 'start' })
  })

  it('also positions immediately with reduced motion on small screens', async () => {
    window.matchMedia = vi.fn(() => ({ matches: true }))

    const { container } = await storedApp()

    withLayout(667, 2000)
    await clickCard(container, 'Lernabschnitt 1')
    expect(scrollIntoView.mock.calls[0][0]).toEqual({ behavior: 'auto', block: 'center' })
  })
})

describe('prefers-reduced-motion', () => {
  const reduced = (matches) => {
    window.matchMedia = vi.fn((query) => ({ matches: matches && query.includes('prefers-reduced-motion'), media: query }))
  }

  it('positions immediately (no smooth scrolling) when reduced motion is requested', async () => {
    reduced(true)

    const { container } = await storedApp()

    await clickCard(container, 'Lernabschnitt 1')
    expect(window.matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)')
    expect(scrollIntoView.mock.calls[0][0]).toEqual({ behavior: 'auto', block: 'start' })
    expect(document.activeElement).toBe(buttonByText(container, 'Lernrunde starten'))
  })

  it('scrolls smoothly when no reduction is requested', async () => {
    reduced(false)

    const { container } = await storedApp()

    await clickCard(container, 'Lernabschnitt 1')
    expect(scrollIntoView.mock.calls[0][0]).toEqual({ behavior: 'smooth', block: 'start' })
  })

  it('does not break in environments without matchMedia or scrollIntoView', async () => {
    delete Element.prototype.scrollIntoView

    const { container } = await storedApp()

    await clickCard(container, 'Lernabschnitt 1')
    expect(document.activeElement).toBe(buttonByText(container, 'Lernrunde starten'))
    expect(container.querySelector('.import-report')).toBeNull()
  })
})

describe('the other start variants', () => {
  it('"Weiterlernen" with a resumable round: scrolls and focuses "Lernrunde fortsetzen"', async () => {
    const first = mountApp()

    await importFiles(first.container, ALL.map(file))
    await vi.waitFor(() => expect(sectionCards(first.container).length).toBe(3))
    await clickCard(first.container, 'Lernabschnitt 1')
    await startQuiz(first.container)
    await answerCurrent(first.container, LIB_ONE, { correct: true })
    await settle(60)

    const { container } = await reloadWithoutImport(first)

    await vi.waitFor(() => expect(sectionCards(container).length).toBe(3))
    await settle(40)
    scrollIntoView.mockClear()
    expect(cardButton(container, 'Lernabschnitt 1').textContent.trim()).toBe('Weiterlernen')
    await clickCard(container, 'Lernabschnitt 1')
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(buttonByText(container, 'Lernrunde fortsetzen'))
    expect(container.querySelector('.question-card')).toBeNull()

    // Resume unverändert: gleiche Frage wie vor dem Neustart.
    document.activeElement.click()
    await vi.waitFor(() => expect(heading(container)).not.toBeNull())
  })

  it('a completed round: focus goes to "Neue Runde starten"', async () => {
    const first = mountApp()

    await importFiles(first.container, [file(LIB_ONE)])
    await vi.waitFor(() => expect(sectionCards(first.container).length).toBe(1))
    await clickCard(first.container, 'Lernabschnitt 1')
    await startQuiz(first.container)

    for (let index = 0; index < 3; index++) {
      await answerCurrent(first.container, LIB_ONE, { correct: true })

      if (index < 2) {
        await next(first.container)
      }
    }

    buttonByText(first.container, 'Auswertung anzeigen').click()
    await nextTick()
    await settle(60)

    const { container } = await reloadWithoutImport(first)

    await vi.waitFor(() => expect(sectionCards(container).length).toBe(1))
    await settle(40)
    scrollIntoView.mockClear()
    await clickCard(container, 'Lernabschnitt 1')
    expect(text(container.querySelector('[aria-label="Lernrunde"]'))).toContain('Lernrunde abgeschlossen')
    expect(buttonByText(container, 'Lernrunde fortsetzen')).toBeUndefined()
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(buttonByText(container, 'Neue Runde starten'))
  })
})

describe('nothing else changes', () => {
  it('opening a section only reads: libraries, progress and sessions stay untouched', async () => {
    const { container } = await storedApp()
    const snapshot = async () =>
      JSON.stringify(
        await withStore(async (store) => [await store.listLibraryStates(), await store.listAllProgress(), await store.listExamAttempts(), await store.getLatestSectionSession('la01')]),
      )
    const before = await snapshot()

    await clickCard(container, 'Lernabschnitt 1')
    expect(await snapshot()).toBe(before)
  })

  it('the exam entry and the section grid stay where they are', async () => {
    const { container } = await storedApp()

    await clickCard(container, 'Lernabschnitt 1')
    expect(sectionCards(container)).toHaveLength(3)
    expect(container.querySelector('.exam-entry')).not.toBeNull()
  })

  it('confirming a library update does not scroll away from the import result', async () => {
    const first = mountApp()

    await importFiles(first.container, [file(LIB_ONE)])
    await vi.waitFor(() => expect(sectionCards(first.container).length).toBe(1))

    const revised = lib('lib-nav-one', 'la01', 'sec-a01', {
      libraryVersion: '1.1.0',
      activeQuestionIndexHash: hash('e'),
      contentRevisions: { [LIB_ONE.questions[1].id]: 2 },
    })
    const { container } = await reloadWithoutImport(first)

    await vi.waitFor(() => expect(sectionCards(container).length).toBe(1))
    await importFiles(container, [{ name: 'lib-nav-one-v110.json', data: revised }])
    await settle(40)
    scrollIntoView.mockClear()

    const confirm = [...container.querySelectorAll('.import-problems button')].find((button) => button.textContent.trim() === 'Aktualisierung übernehmen')

    confirm.click()
    await vi.waitFor(() => expect(container.querySelector('.import-problems')).toBeNull())
    await settle(60)
    expect(scrollIntoView).not.toHaveBeenCalled()
    expect(detail(container)).not.toBeNull() // Abschnitt wird weiterhin geöffnet
  })
})
