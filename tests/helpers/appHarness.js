// Gemeinsame Hilfsfunktionen für App-Tests (jsdom). Nur synthetische Daten.
import { createApp, nextTick } from 'vue'
import { vi, expect } from 'vitest'
import App from '../../src/App.vue'
import { createProgressStore } from '../../src/storage/progressStore.js'

const DB_NAME = 'cybersecurity-concepts-quiz'
export function getMounted() {
  return mounted
}
export const DB_NAME_APP = DB_NAME
let mounted = []

export function mountApp() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp(App)
  app.mount(container)
  const entry = { app, container }
  mounted.push(entry)
  return entry
}

export function unmountApp(entry) {
  entry.app.unmount()
  entry.container.remove()
  mounted = mounted.filter((item) => item !== entry)
}

export async function settle(ms = 60) {
  await new Promise((resolve) => setTimeout(resolve, ms))
  await nextTick()
}

// Wählt eine Datei aus und wartet auf das Ergebnis (V1: Label, V2/Registry: Import-Ergebnis).
export async function importJson(container, data, fileName = 'test.json') {
  const input = container.querySelector('input[type="file"]')
  const file = { name: fileName, text: async () => JSON.stringify(data) }

  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  input.dispatchEvent(new Event('change'))
  await vi.waitFor(() => {
    const label = container.querySelector('.question-bank-label').textContent
    expect(
      label.includes(fileName) || container.querySelector('.import-report') || container.querySelector('.library-message-warning'),
    ).toBeTruthy()
  })
  await settle()
}

// Mehrere Dateien gemeinsam auswählen: files = [{ name, data }]
export async function importFiles(container, files) {
  const input = container.querySelector('input[type="file"]')
  const selected = files.map(({ name, data, raw }) => ({ name, text: async () => raw ?? JSON.stringify(data) }))

  Object.defineProperty(input, 'files', { value: selected, configurable: true })
  input.dispatchEvent(new Event('change'))
  await vi.waitFor(() => expect(container.querySelector('.import-report')).not.toBeNull())
  await settle()
}

export function sectionCards(container) {
  return [...container.querySelectorAll('.section-card')]
}

export function sectionCard(container, label) {
  return sectionCards(container).find((card) => card.querySelector('h3').textContent === label)
}

// Öffnet einen Lernabschnitt über die Karte (kein Datei-Dialog).
export async function openSection(container, label = 'Lernabschnitt 99') {
  await vi.waitFor(() => expect(sectionCard(container, label)).toBeDefined())
  sectionCard(container, label).querySelector('button').click()
  await vi.waitFor(() => expect(container.querySelector('[aria-label="Lernabschnitt"]')?.textContent).toContain(label))
  await settle()
}

export function sectionLabelOf(library) {
  const id = library.questions[0].learningSectionId

  return `Lernabschnitt ${Number(id.replace(/^la/, ''))}`
}

// Importiert eine V2-Library und öffnet danach ihren Lernabschnitt (entspricht dem früheren "Datei laden").
export async function importAndOpen(container, library, fileName = 'test.json') {
  await importJson(container, library, fileName)

  if (!Array.isArray(library)) {
    await openSection(container, sectionLabelOf(library))
  }
}

export function buttonByText(container, text) {
  return [...container.querySelectorAll('button')].find((button) => button.textContent.trim() === text)
}

export function answerButtons(container) {
  return [...container.querySelectorAll('.answer-button')]
}

export function optionTexts(container) {
  return answerButtons(container).map((button) => button.textContent.trim())
}

export function heading(container) {
  return container.querySelector('.question-card h2')?.textContent ?? null
}

export function scoreText(container) {
  return container.querySelector('.score-card')?.textContent.replace(/\s+/g, ' ').trim()
}

export async function startQuiz(container) {
  const button = buttonByText(container, 'Lernrunde starten') ?? buttonByText(container, 'Mit aktueller Fragebank starten')

  button.click()
  await vi.waitFor(() => expect(heading(container)).not.toBeNull())
}

export async function resume(container) {
  buttonByText(container, 'Lernrunde fortsetzen').click()
  await vi.waitFor(() => expect(heading(container)).not.toBeNull())
}

// Beantwortet die aktuelle Frage und gibt ihre Question-ID zurück.
export async function answerCurrent(container, library, { correct }) {
  const source = library.questions.find((question) => question.localized.de.question === heading(container))
  const expected = source.localized.de.optionText[source.correctOptionKey]
  const button = answerButtons(container).find((candidate) => (candidate.textContent.trim() === expected) === correct)

  button.click()
  await nextTick()
  return source.id
}

export async function next(container) {
  buttonByText(container, 'Nächste Frage').click()
  await nextTick()
}

// Reload = alte App-Instanz weg, neue App-Instanz, Library-Datei wird erneut geladen.
export async function reload(entry, library, fileName = 'v2.json') {
  await settle()
  unmountApp(entry)
  const fresh = mountApp()
  await importAndOpen(fresh.container, library, fileName)
  return fresh
}

// Neustart ohne erneute Dateiauswahl: der Katalog kommt aus dem lokalen Speicher.
export async function reloadWithoutImport(entry) {
  await settle()
  unmountApp(entry)

  return mountApp()
}

export async function withStore(callback) {
  const store = createProgressStore({ dbName: DB_NAME })
  await store.initialize()

  try {
    return await callback(store)
  } finally {
    store.close()
  }
}


export function resetBrowserStorage() {
  window.alert = vi.fn()
  globalThis.indexedDB = new (globalThis.indexedDB.constructor)()
}

export function unmountAll() {
  mounted.slice().forEach(unmountApp)
}
