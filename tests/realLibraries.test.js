// @vitest-environment jsdom
// Lokaler Pilot gegen die echten finalen V2-Libraries (nur lesend). Läuft nur mit
// SECURITY_REPO_PATH=<security-repo>; die Dateien werden nie ins App-Repo kopiert.
import 'fake-indexeddb/auto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  answerButtons,
  buttonByText,
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
  sectionCards,
  settle,
  startQuiz,
  unmountAll,
  withStore,
} from './helpers/appHarness.js'

const root = process.env.SECURITY_REPO_PATH

describe.skipIf(!root || !existsSync(root))('real pilot: multi-library import (local security repo)', () => {
  const dir = root ? join(root, 'audit/final') : ''
  let files

  beforeEach(() => {
    resetBrowserStorage()
    files = readdirSync(dir)
      .filter((name) => /^security-plus-v2-la\d\d-.*\.json$/.test(name))
      .map((name) => ({ name, data: JSON.parse(readFileSync(join(dir, name), 'utf8')) }))
  })
  afterEach(unmountAll)

  it('imports all libraries together, groups them by learning section and survives restarts', async () => {
    // Erwartung wird aus den Dateien berechnet, nicht hartcodiert.
    const activeQuestions = files.flatMap(({ data }) => data.questions.filter((question) => question.status === 'active'))
    const ids = activeQuestions.map((question) => question.id)
    const sections = [...new Set(activeQuestions.map((question) => question.learningSectionId))].sort()

    expect(new Set(ids).size).toBe(ids.length)

    let app = mountApp()

    await importFiles(app.container, files)

    const summary = app.container.querySelector('.import-summary').textContent
    const number = (value) => value.toLocaleString('de-DE')

    expect(summary).toBe(
      `${files.length} Dateien geprüft · ${files.length} Libraries erkannt · ${sections.length} Lernabschnitte · ${number(ids.length)} aktive Fragen`,
    )
    expect(app.container.querySelectorAll('.library-message-error')).toHaveLength(0)
    expect(sectionCards(app.container)).toHaveLength(sections.length)

    // Jede Karte: Library- und Fragenanzahl aus den Dateien.
    sections.forEach((sectionId) => {
      const label = `Lernabschnitt ${Number(sectionId.replace('la', ''))}`
      const sectionFiles = files.filter(({ data }) => data.questions.some((question) => question.learningSectionId === sectionId))
      const questionCount = activeQuestions.filter((question) => question.learningSectionId === sectionId).length
      const text = sectionCard(app.container, label).textContent.replace(/\s+/g, ' ')

      expect(text).toContain(`${sectionFiles.length} ${sectionFiles.length === 1 ? 'Library' : 'Libraries'}`)
      expect(text).toContain(`${questionCount} Fragen`)
    })

    // Lernabschnitt mit mehreren Libraries öffnen, mehrere Fragen beantworten.
    const multi = sections.find((sectionId) => files.filter(({ data }) => data.questions[0].learningSectionId === sectionId).length > 1)
    const multiLabel = `Lernabschnitt ${Number(multi.replace('la', ''))}`

    await openSection(app.container, multiLabel)
    await startQuiz(app.container)

    const session = await withStore((store) => store.getLatestSectionSession(multi))

    expect(new Set(Object.values(session.questionLibraries)).size).toBeGreaterThan(1)

    for (let index = 0; index < 4; index++) {
      answerButtons(app.container)[index % 4].click()
      await settle(20)
      await next(app.container)
    }

    const shownHeading = heading(app.container)
    const order = (await withStore((store) => store.getLatestSectionSession(multi))).orderedQuestionIds

    await settle()

    // Reload und vollständiger Neustart ohne Datei-Auswahl.
    for (let restart = 0; restart < 2; restart++) {
      app = await reloadWithoutImport(app)
      await vi.waitFor(() => expect(sectionCards(app.container)).toHaveLength(sections.length))
      expect(app.container.querySelector('.import-report')).toBeNull()
      expect(sectionCard(app.container, multiLabel).textContent).toContain('Resume: Ja')

      await openSection(app.container, multiLabel)
      await resume(app.container)
      expect(heading(app.container)).toBe(shownHeading)
      expect(scoreText(app.container)).toContain('Frage 5 von')
      expect((await withStore((store) => store.getLatestSectionSession(multi))).orderedQuestionIds).toEqual(order)
      expect(buttonByText(app.container, 'Nächste Frage') ?? true).toBeTruthy()
    }

    // Erneuter Import derselben Dateien ändert nichts (idempotent), Fortschritt bleibt.
    app = await reloadWithoutImport(app)
    await importFiles(app.container, files)
    expect(app.container.querySelectorAll('.import-results li')).toHaveLength(files.length)
    expect([...app.container.querySelectorAll('.import-results .import-status')].every((node) => node.textContent === 'Bereits aktuell')).toBe(true)
    expect((await withStore((store) => store.listAllProgress())).length).toBe(4)
  }, 120000)

  it('reports the real numbers (for the report)', () => {
    const active = files.flatMap(({ data }) => data.questions.filter((question) => question.status === 'active'))

    console.log(
      JSON.stringify({
        libraries: files.length,
        sections: new Set(active.map((question) => question.learningSectionId)).size,
        activeQuestions: active.length,
        duplicateIds: active.length - new Set(active.map((question) => question.id)).size,
      }),
    )
    expect(files.length).toBeGreaterThan(0)
  })
})
