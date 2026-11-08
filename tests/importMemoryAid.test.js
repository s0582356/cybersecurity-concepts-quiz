// @vitest-environment jsdom
// V2-Importvertrag für `memoryAid` (Pre-Housekeeping): Ist `memoryAid` in einer Fassung vorhanden, ist `memoryAid.type`
// Pflicht und muss ein Wert des geschlossenen V2-Enums sein (SECURITY_QUESTION_SCHEMA_V2: `localizedContent.memoryAid`
// required [type, text]). Das gilt für `localized.de` wie `localized.en`; fehlt `memoryAid` ganz, bleibt DE gültig.
// Ein schema-ungültiger Typ wird NICHT still repariert oder in eine Forward-Compatibility-Regel umgedeutet.
// Nur synthetische Daten; die echten Libraries werden nur mit SECURITY_REPO_PATH gelesen.
import 'fake-indexeddb/auto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MEMORY_AID_TYPES } from '../src/domain/questionContent.js'
import { LibraryParseError, parseQuestionFile, parseV1Questions, parseV2Library } from '../src/lib/library/parseLibrary.js'
import { createExamAttempt } from '../src/domain/examAttempt.js'
import { readExamPool, startExam } from '../src/storage/examService.js'
import { de } from '../src/i18n/de.js'
import { en } from '../src/i18n/en.js'
import { importFiles, mountApp, resetBrowserStorage, settle, unmountAll, withStore } from './helpers/appHarness.js'
import { clone, makeExamLibraryData, seededRandom } from './fixtures/examFixtures.js'
import { makeSyntheticLibrary, V1_QUESTIONS } from './fixtures/syntheticLibrary.js'

beforeEach(resetBrowserStorage)
afterEach(() => {
  vi.restoreAllMocks()
  unmountAll()
})

const library = (options = {}) => makeSyntheticLibrary({ count: 6, english: 'all', ...options })

// Setzt `memoryAid` einer Fassung (undefined = Feld entfernen).
function withAid(data, locale, aid, index = 2) {
  const copy = clone(data)

  if (aid === undefined) {
    delete copy.questions[index].localized[locale].memoryAid
  } else {
    copy.questions[index].localized[locale].memoryAid = aid
  }

  return copy
}

function rejection(data) {
  try {
    parseV2Library(data)
  } catch (error) {
    return error
  }

  return null
}

describe('V2 import: memoryAid.type in the German localization', () => {
  it('A: a memory aid with a valid enum type is accepted (every enum value)', () => {
    MEMORY_AID_TYPES.forEach((type) => {
      const { questions } = parseV2Library(withAid(library(), 'de', { type, text: 'Merkhilfe' }))

      expect(questions[2].localized.de.memoryAid).toEqual({ type, text: 'Merkhilfe' })
    })
  })

  it('B: a memory aid without type is rejected with the existing import-error pattern (key, question number, id)', () => {
    const error = rejection(withAid(library(), 'de', { text: 'Merkhilfe ohne Typ' }))

    expect(error).toBeInstanceOf(LibraryParseError)
    expect(error.i18n).toEqual({ i18n: 'parse.v2.germanMemoryAid', params: { n: 3, id: 'sec-a30-0003' } })
    expect(error.message).toBe('V2-Frage 3 (sec-a30-0003): deutsche Merkhilfe ohne gültigen "type" (erwartet: einer der V2-Typen).')
  })

  it('C: unknown, empty, mis-cased, null, numeric or non-string types are rejected (no silent repair, no forward-compatibility)', () => {
    for (const type of ['future_type', '', ' mnemonic', 'Mnemonic', 'MNEMONIC', 'rule-of-thumb', null, 7, true, ['mnemonic'], { value: 'mnemonic' }]) {
      const error = rejection(withAid(library(), 'de', { type, text: 'Merkhilfe' }))

      expect(error, JSON.stringify(type)).toBeInstanceOf(LibraryParseError)
      expect(error.i18n.i18n, JSON.stringify(type)).toBe('parse.v2.germanMemoryAid')
    }
  })

  it('C: a present memory aid that is not an object with a type (string, number, array, empty object) is rejected', () => {
    for (const aid of ['Merkhilfe als Text', 42, ['mnemonic'], {}, true]) {
      expect(rejection(withAid(library(), 'de', aid)), JSON.stringify(aid)).toBeInstanceOf(LibraryParseError)
    }
  })

  it('D: no memory aid at all stays valid (schema leniency for older content is unchanged), as missing field or null', () => {
    for (const aid of [undefined, null]) {
      const { questions } = parseV2Library(withAid(library(), 'de', aid))

      expect(questions[2].localized.de.memoryAid).toBeNull()
    }
  })

  it('does not tighten other existing structure rules: a type with a missing text is still imported as before (text rules are unchanged)', () => {
    const { questions } = parseV2Library(withAid(library(), 'de', { type: 'mnemonic' }))

    expect(questions[2].localized.de.memoryAid).toBeNull() // unverändert: Normalisierung verwirft eine Merkhilfe ohne Text
  })

  it('rejects the whole library and names the first offending question (deterministic, no partial result)', () => {
    const data = withAid(withAid(library(), 'de', { text: 'x' }, 4), 'de', { text: 'y' }, 1)
    const error = rejection(data)

    expect(error.i18n.params).toEqual({ n: 2, id: 'sec-a30-0002' })
  })

  it('inactive (retired) questions are not validated, like every other German structure rule', () => {
    const data = library()

    data.questions[2].status = 'retired'
    data.questions[2].localized.de.memoryAid = { text: 'ohne Typ' }

    expect(rejection(data)).toBeNull()
  })
})

describe('V2 import: English localization stays as strict as before (no regression, no loosening)', () => {
  it('E: a valid English memory aid is accepted and kept', () => {
    const { questions, library: parsed } = parseV2Library(library())

    expect(questions[2].localized.en.memoryAid).toMatchObject({ type: 'mini_scenario' })
    expect(parsed.contentCoverage).toEqual({ de: 6, en: 6 })
  })

  it('F: an English memory aid without type or with an unknown type is still not accepted as English (German stays importable, the issue is reported)', () => {
    for (const aid of [{ text: 'no type' }, { type: 'future_type', text: 'x' }, undefined, null, 'text']) {
      const { questions, library: parsed } = parseV2Library(withAid(library(), 'en', aid))

      expect(questions[2].localized.en, JSON.stringify(aid)).toBeNull()
      expect(parsed.contentCoverage.en).toBe(5)
      expect(parsed.languageIssues).toEqual([{ id: 'sec-a30-0003', locale: 'en', problem: 'memoryAid' }])
      expect(questions[2].localized.de.memoryAid).toMatchObject({ type: 'mini_scenario' })
    }
  })
})

describe('legacy / V1 contract is not tightened', () => {
  it('a V1 file with an extra typeless memoryAid field and a V1 file without it import as before', () => {
    const withExtra = V1_QUESTIONS.map((question) => ({ ...question, memoryAid: { text: 'ohne Typ' } }))

    expect(parseQuestionFile(withExtra)).toMatchObject({ format: 'v1' })
    expect(parseV1Questions(V1_QUESTIONS)).toHaveLength(V1_QUESTIONS.length)
  })

  it('a V2 library whose questions have no memoryAid at all (older style) is still importable', () => {
    const data = library()

    data.questions.forEach((question) => {
      delete question.localized.de.memoryAid
    })

    expect(parseQuestionFile(data)).toMatchObject({ format: 'v2' })
  })
})

describe('i18n of the new import error', () => {
  it('exists in German and English with the same placeholders', () => {
    expect(de['parse.v2.germanMemoryAid']).toBeTypeOf('string')
    expect(en['parse.v2.germanMemoryAid']).toBeTypeOf('string')
    expect(en['parse.v2.germanMemoryAid'].match(/\{\w+\}/g).sort()).toEqual(de['parse.v2.germanMemoryAid'].match(/\{\w+\}/g).sort())
    expect(en['parse.v2.germanMemoryAid']).toContain('{n}')
    expect(en['parse.v2.germanMemoryAid']).toContain('{id}')
  })
})

describe('G: a rejected library is never partially persisted (real import UI)', () => {
  const sizes = { la01: 12, la02: 12, la03: 12 }
  const files = (dataList) => dataList.map((data, index) => ({ name: `lib-${index}.json`, data }))
  const persisted = () =>
    withStore(async (store) => ({
      states: (await store.listLibraryStates()).map((state) => state.libraryId),
      contents: await Promise.all((await store.listLibraryStates()).map((state) => store.getLibraryContent(state.libraryId))),
      progress: await store.listAllProgress(),
      attempts: await store.listExamAttempts(),
    }))

  it('a single invalid library: error message shown, nothing stored (no state, content, progress)', async () => {
    const app = mountApp()
    const bad = makeExamLibraryData(sizes)

    bad[1].questions[3].localized.de.memoryAid = { text: 'ohne Typ' }
    await importFiles(app.container, files([bad[1]]))

    expect(app.container.textContent).toContain('deutsche Merkhilfe ohne gültigen')
    expect(app.container.textContent).toContain('sec-a02-0004')
    expect(await persisted()).toEqual({ states: [], contents: [], progress: [], attempts: [] })
  })

  it('a valid and an invalid library together: only the valid one is imported completely, the invalid one leaves no trace', async () => {
    const app = mountApp()
    const data = makeExamLibraryData(sizes)

    data[1].questions[3].localized.de.memoryAid = { type: 'future_type', text: 'x' }
    await importFiles(app.container, files(data))
    await settle(30)

    const stored = await persisted()

    expect(stored.states.sort()).toEqual(['exam-lib-la01', 'exam-lib-la03'])
    expect(stored.contents.map((content) => content.questions.length)).toEqual([12, 12])
    expect(JSON.stringify(stored.contents)).not.toContain('future_type')
    expect(JSON.stringify(stored)).not.toContain('exam-lib-la02')
  })
})

describe('reproduction of the former exam-start problem: rejected at the source, deterministically', () => {
  const sizes = { la01: 10, la02: 10, la03: 10 } // 30 Fragen: ein Preset "Kurz" (20) zieht die meisten davon
  const bad = () => {
    const data = makeExamLibraryData(sizes)

    data[0].questions[0].localized.de.memoryAid = { text: 'ohne Typ' } // genau eine Frage

    return data
  }

  it('the import is rejected on every attempt (no dependence on any random selection), so the question can never enter the exam pool', () => {
    for (let attempt = 0; attempt < 25; attempt++) {
      expect(rejection(bad()[0])?.i18n.i18n, `attempt ${attempt}`).toBe('parse.v2.germanMemoryAid')
    }
  })

  it('with the other libraries imported, 40 of 40 exam starts and 40 of 40 preset dry runs succeed (no intermittent invalidAttempt, no preset shown as 0)', async () => {
    const app = mountApp()
    const data = bad()

    await importFiles(app.container, data.map((item, index) => ({ name: `lib-${index}.json`, data: item })))
    await settle(30)

    const { pool, libraries } = await withStore((store) => readExamPool(store))

    expect(pool).toHaveLength(20) // die abgelehnte Library fehlt vollständig; die anderen beiden sind komplett da
    expect(pool.some((entry) => entry.question.id === 'sec-a01-0001')).toBe(false)

    for (let seed = 1; seed <= 40; seed++) {
      expect(() => createExamAttempt({ pool, libraries, preset: 'short', language: 'de', random: seededRandom(seed) }), `dry run ${seed}`).not.toThrow()

      const started = await withStore(async (store) => {
        const result = await startExam(store, { preset: 'short', language: 'de', random: seededRandom(seed), now: 1000 + seed })

        await store.discardActiveExamAttempt(result.attempt.examSessionId)

        return result.started
      })

      expect(started, `start ${seed}`).toBe(true)
    }
  })

  it('the exam-snapshot validation itself is unchanged and still strict (defence in depth)', () => {
    const data = makeExamLibraryData(sizes)
    const { questions, library: parsed } = parseV2Library(data[0])
    const pool = questions.map((question) => ({ question, libraryId: parsed.libraryId, sectionId: parsed.learningSectionId }))
    const tampered = clone(pool)

    tampered.forEach((entry) => {
      entry.question.localized.de.memoryAid = { type: null, text: 'ohne Typ' }
    })

    expect(() => createExamAttempt({ pool: tampered, libraries: [], count: 10, language: 'de', random: seededRandom(1) })).toThrow()
  })
})

// H: nur mit lokalem Security-Repo (wie die übrigen Real-Library-Tests).
const root = process.env.SECURITY_REPO_PATH

describe.skipIf(!root || !existsSync(root))('H: the 24 real libraries import completely under the stricter contract', () => {
  it('24 of 24 accepted, 1179 of 1179 active questions, 9 learning sections, no import error, every German and English memory aid has a valid type', () => {
    const dir = join(root, 'audit/final')
    const names = readdirSync(dir).filter((name) => /^security-plus-v2-la\d+-.*\.json$/.test(name)).sort()
    const sections = new Set()
    let questions = 0

    expect(names).toHaveLength(24)
    names.forEach((name) => {
      const raw = JSON.parse(readFileSync(join(dir, name), 'utf8'))
      const parsed = parseQuestionFile(raw)

      expect(parsed.format, name).toBe('v2')
      questions += parsed.questions.length
      sections.add(parsed.library.learningSectionId)
      parsed.questions.forEach((question) => {
        expect(MEMORY_AID_TYPES).toContain(question.localized.de.memoryAid?.type)
        expect(MEMORY_AID_TYPES).toContain(question.localized.en?.memoryAid?.type)
      })
      expect(parsed.library.languageIssues, name).toEqual([])
    })
    expect(questions).toBe(1179)
    expect(sections.size).toBe(9)
  })

  it('H: importing all 24 real files through the import UI reports 24 libraries, 9 sections and 1.179 active questions without any rejected file', async () => {
    const dir = join(root, 'audit/final')
    const names = readdirSync(dir).filter((name) => /^security-plus-v2-la\d+-.*\.json$/.test(name)).sort()
    const app = mountApp()

    await importFiles(app.container, names.map((name) => ({ name, raw: readFileSync(join(dir, name), 'utf8') })))
    await settle(30)

    const report = app.container.querySelector('.import-report').textContent.replace(/\s+/g, ' ')

    expect(report).toContain('24 Dateien geprüft · 24 Libraries erkannt · 9 Lernabschnitte · 1.179 aktive Fragen')
    expect(app.container.querySelector('.library-message-error')).toBeNull()
    expect(await withStore((store) => store.listLibraryStates())).toHaveLength(24)
  })
})
