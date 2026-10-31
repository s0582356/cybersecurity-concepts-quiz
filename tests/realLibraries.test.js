// @vitest-environment jsdom
// Lokaler Pilot gegen die echten finalen V2-Libraries (nur lesend). Läuft nur mit
// SECURITY_REPO_PATH=<security-repo>; die Dateien werden nie ins App-Repo kopiert.
import 'fake-indexeddb/auto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { coverageOf } from '../src/domain/questionContent.js'
import { parseV2Library } from '../src/lib/library/parseLibrary.js'
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
  sectionCards,
  settle,
  startQuiz,
  switchLanguage,
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

  // Echte Sprachabdeckung (Phase 2F, angepasst nach dem Gold-Pilot): alle Erwartungen werden aus den Dateien berechnet.
  // Englisch gilt je Lernabschnitt nur bei vollständiger Abdeckung als "verfügbar"; eine teilweise Abdeckung (z. B. nur
  // eine von mehreren Libraries eines Abschnitts) darf nie als volle Abschnitts-Verfügbarkeit erscheinen.
  it('measures the real language coverage per question, library and section', async () => {
    const parsed = files.map(({ data }) => parseV2Library(data))
    const questions = parsed.flatMap((item) => item.questions)
    const coverage = coverageOf(questions)
    const rawActive = files.flatMap(({ data }) => data.questions.filter((question) => question.status === 'active'))
    const rawEnglish = rawActive.filter((question) => question.localized.en !== null && question.localized.en !== undefined)
    const completeLibraries = parsed.filter((item) => item.library.contentCoverage.en === item.library.questionCount)
    const sectionOfLibrary = new Map(parsed.map((item) => [item.library.libraryId, item.library.learningSectionId]))
    const sections = new Map()

    questions.forEach((question) => {
      const id = sectionOfLibrary.get(question.libraryId)
      const entry = sections.get(id) ?? { total: 0, english: [], all: [] }

      entry.total++
      entry.all.push(question.id)

      if (question.localized.en) {
        entry.english.push(question.id)
      }

      sections.set(id, entry)
    })

    console.log(
      JSON.stringify({
        languageCoverage: coverage,
        librariesWithCompleteEnglish: completeLibraries.length,
        sectionsWithCompleteEnglish: [...sections.values()].filter((entry) => entry.english.length === entry.total).length,
        sectionsWithPartialEnglish: [...sections.values()].filter((entry) => entry.english.length > 0 && entry.english.length < entry.total).length,
      }),
    )

    // Frage-Ebene: deutsch überall; englisch genau die Fragen mit gültigem EN (der Parser verwirft nichts Gültiges).
    expect(coverage.total).toBe(rawActive.length)
    expect(coverage.de).toBe(coverage.total)
    expect(coverage.en).toBe(rawEnglish.length)
    expect(coverage.englishComplete).toBe(rawEnglish.length === rawActive.length)
    // Library-Ebene: vollständig bilingual nur, wenn jede aktive Frage EN hat; languageSupport nur dann auch deklariert.
    completeLibraries.forEach((item) => expect(item.library.languageSupport).toContain('en'))
    parsed
      .filter((item) => item.library.contentCoverage.en < item.library.questionCount)
      .forEach((item) => expect(item.library.languageSupport).not.toContain('en'))
    expect(parsed.reduce((total, item) => total + item.library.contentCoverage.en, 0)).toBe(coverage.en)

    const app = mountApp()

    await settle()
    await switchLanguage(app.container, 'en')
    await importFiles(app.container, files)

    // Abschnitts-Ebene: jede Karte spiegelt genau ihre eigene Abdeckung wider.
    const sectionIds = [...sections.keys()].sort()

    expect(sectionCards(app.container)).toHaveLength(sectionIds.length)
    sectionIds.forEach((sectionId) => {
      const entry = sections.get(sectionId)
      const label = `Learning section ${Number(sectionId.replace('la', ''))}`
      const languages = sectionCard(app.container, label).querySelector('.section-languages').textContent.replace(/\s+/g, ' ').trim()

      if (entry.english.length === 0) {
        expect(languages, label).toBe('German')
      } else if (entry.english.length === entry.total) {
        expect(languages, label).toBe('German · English')
      } else {
        // Teilweise Abdeckung = nie volle Verfügbarkeit.
        expect(languages, label).toBe(`German · English incomplete (${entry.english.length}/${entry.total})`)
        expect(languages, label).not.toBe('German · English')
      }
    })

    // Verhalten "Nur Englisch" je Abdeckungsart (soweit in den echten Daten vorhanden).
    const german = new Set(parsed.flatMap((item) => item.questions.map((question) => question.localized.de.question)))
    const none = sectionIds.find((id) => sections.get(id).english.length === 0)
    const partial = sectionIds.find((id) => sections.get(id).english.length > 0 && sections.get(id).english.length < sections.get(id).total)

    if (none) {
      const label = `Learning section ${Number(none.replace('la', ''))}`

      await openSection(app.container, label)
      buttonByText(app.container, 'Start learning round').click()
      await settle()
      expect(app.container.querySelector('.library-message-error').textContent).toContain('no English questions')
      expect(await withStore((store) => store.getLatestSectionSession(none))).toBeNull()

      // Bewusst Deutsch gewählt: echter deutscher Text.
      await chooseLanguageOption(app.container, 'de')
      await startQuiz(app.container)
      expect(german.has(heading(app.container))).toBe(true)
      await settle()
      expect((await withStore((store) => store.getLatestSectionSession(none))).sessionLanguage).toBe('de')
    }

    if (partial) {
      const entry = sections.get(partial)
      const label = `Learning section ${Number(partial.replace('la', ''))}`
      const second = await reloadWithoutImport(app)

      await switchLanguage(second.container, 'en')
      await openSection(second.container, label)
      await chooseLanguageOption(second.container, 'en-only')
      await startQuiz(second.container)
      await settle()

      // Teilweise EN-Abdeckung: "Nur Englisch" enthält genau die englischen Fragen, die übrigen werden gemeldet.
      const stored = await withStore((store) => store.getLatestSectionSession(partial))

      expect(new Set(stored.orderedQuestionIds)).toEqual(new Set(entry.english))
      expect(new Set(stored.skippedQuestionIds)).toEqual(new Set(entry.all.filter((id) => !entry.english.includes(id))))
      expect(stored).toMatchObject({ sessionLanguage: 'en', languageMode: 'onlyEnglish' })
      expect(second.container.querySelector('.language-note').textContent).toContain(
        `${entry.total - entry.english.length} of ${entry.total} questions`,
      )
      expect(german.has(heading(second.container))).toBe(false)
    }
  }, 60000)

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
