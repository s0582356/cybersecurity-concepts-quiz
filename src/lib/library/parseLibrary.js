// Parsing und Validierung geladener Fragedateien.
//
// V1: flaches Array von Fragen (bestehendes Format, unverändert).
// V2: Library-Objekt mit Metadaten und `questions[]` (siehe SECURITY_QUESTION_SCHEMA_V2).
//
// Der V2-Pfad prüft nur das, was die App für Phase 2A braucht; er ersetzt keinen
// vollständigen Schema-Validator.

import { parseRetiredIndex } from '../../domain/replacementMigration.js'
import {
  normalizeLocalizedContent,
  validateEnglishContent,
  validateLocalizedContent,
} from '../../domain/questionContent.js'
import { msg, translate } from '../../i18n/index.js'

// Fehler tragen einen Meldungsschlüssel samt Parametern (`i18n`); `message` ist die deutsche Standardfassung.
export class LibraryParseError extends Error {
  constructor(key, params = {}) {
    super(translate('de', key, params))
    this.name = 'LibraryParseError'
    this.i18n = msg(key, params)
  }
}

const SUPPORTED_V2_SCHEMA = /^2\.\d+\.\d+$/
const LIBRARY_ID_PATTERN = /^[a-z0-9-]{3,64}$/
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/
const QUESTION_ID_PATTERN = /^sec-a\d{2}-\d{4}$/
const SECTION_ID_PATTERN = /^[a-z0-9-]{2,32}$/
const OPTION_KEYS = ['a', 'b', 'c', 'd']

export function parseV1Questions(data) {
  if (!Array.isArray(data)) {
    throw new LibraryParseError('parse.v1.notArray')
  }

  if (data.length === 0) {
    throw new LibraryParseError('parse.v1.empty')
  }

  data.forEach((question, index) => {
    const n = index + 1

    if (!question.question || typeof question.question !== 'string') {
      throw new LibraryParseError('parse.v1.question', { n })
    }

    if (!Array.isArray(question.options) || question.options.length < 2) {
      throw new LibraryParseError('parse.v1.options', { n })
    }

    if (!question.correctAnswer || typeof question.correctAnswer !== 'string') {
      throw new LibraryParseError('parse.v1.correctAnswer', { n })
    }

    if (!question.options.includes(question.correctAnswer)) {
      throw new LibraryParseError('parse.v1.correctInOptions', { n })
    }

    if (!question.explanation || typeof question.explanation !== 'string') {
      throw new LibraryParseError('parse.v1.explanation', { n })
    }

    if (question.category !== undefined && typeof question.category !== 'string') {
      throw new LibraryParseError('parse.v1.category', { n })
    }

    if (question.difficulty !== undefined && typeof question.difficulty !== 'string') {
      throw new LibraryParseError('parse.v1.difficulty', { n })
    }
  })

  return data.map((question, index) => ({
    id: question.id ?? index + 1,
    category: question.category || 'Private Practice',
    difficulty: question.difficulty || 'private',
    question: question.question,
    options: question.options,
    correctAnswer: question.correctAnswer,
    explanation: question.explanation,
  }))
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

// Bereinigte Fassung einer Sprache: nur Struktur, die der Contract vorsieht. Englisch wird nur übernommen, wenn es
// strukturell gültig ist (a–d, Texte, Erklärung); sonst bleibt `en` null und der Befund wird gemeldet.
function toQuizQuestion(question, libraryId, issues) {
  const german = normalizeLocalizedContent(question.localized.de)
  const rawEnglish = question.localized.en
  let english = null

  if (rawEnglish !== null && rawEnglish !== undefined) {
    const check = validateEnglishContent(rawEnglish)

    if (check.valid) {
      english = normalizeLocalizedContent(rawEnglish)
    } else {
      issues.push({ id: question.id, locale: 'en', problem: check.problem })
    }
  }

  Object.keys(question.localized)
    .filter((locale) => locale !== 'de' && locale !== 'en')
    .forEach((locale) => issues.push({ id: question.id, locale, problem: 'unknownLocale' }))

  const options = OPTION_KEYS.map((key) => german.optionText[key])

  return {
    // Persistenter Schlüssel ist (libraryId, id); der Fragetext spielt keine Rolle.
    id: question.id,
    libraryId,
    category: question.topicId || question.learningSectionId || 'Allgemein',
    difficulty: question.difficulty || 'medium',
    // Deutsche Standardansicht (flach, wie bisher); die Anzeige läuft über das Content-Modul.
    question: german.question,
    options,
    correctAnswer: german.optionText[question.correctOptionKey],
    explanation: german.explanation,
    contentRevision: question.contentRevision,
    correctOptionKey: question.correctOptionKey,
    // Keys a–d sind lokal zur Frage; nur für Optionsreihenfolge/Auswahl innerhalb derselben Frage.
    optionTextByKey: { ...german.optionText },
    localized: { de: german, en: english },
  }
}

export function parseV2Library(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new LibraryParseError('parse.v2.notObject')
  }

  if (!isNonEmptyString(data.schemaVersion)) {
    throw new LibraryParseError('parse.v2.schemaMissing')
  }

  if (!SUPPORTED_V2_SCHEMA.test(data.schemaVersion)) {
    throw new LibraryParseError('parse.v2.schemaUnsupported', { version: data.schemaVersion })
  }

  if (!isNonEmptyString(data.libraryId) || !LIBRARY_ID_PATTERN.test(data.libraryId)) {
    throw new LibraryParseError('parse.v2.libraryId')
  }

  if (!isNonEmptyString(data.libraryVersion) || !SEMVER_PATTERN.test(data.libraryVersion)) {
    throw new LibraryParseError('parse.v2.libraryVersion')
  }

  if (!isNonEmptyString(data.activeQuestionIndexHash) || !HASH_PATTERN.test(data.activeQuestionIndexHash)) {
    throw new LibraryParseError('parse.v2.hash')
  }

  if (!Array.isArray(data.questions)) {
    throw new LibraryParseError('parse.v2.questionsNotArray')
  }

  if (data.questions.length === 0) {
    throw new LibraryParseError('parse.v2.questionsEmpty')
  }

  if (data.questionCount !== undefined && data.questionCount !== data.questions.length) {
    throw new LibraryParseError('parse.v2.questionCount')
  }

  if (data.sourceSections !== undefined && !Array.isArray(data.sourceSections)) {
    throw new LibraryParseError('parse.v2.sourceSections')
  }

  if (Array.isArray(data.languageSupport) && !data.languageSupport.includes('de')) {
    throw new LibraryParseError('parse.v2.germanMissingInSupport')
  }

  const seenIds = new Set()
  const activeQuestions = []
  const sectionIds = new Set()
  const languageIssues = []

  data.questions.forEach((question, index) => {
    const n = index + 1

    if (question === null || typeof question !== 'object') {
      throw new LibraryParseError('parse.v2.entryInvalid', { n })
    }

    if (!isNonEmptyString(question.id) || !QUESTION_ID_PATTERN.test(question.id)) {
      throw new LibraryParseError('parse.v2.idInvalid', { n })
    }

    if (seenIds.has(question.id)) {
      throw new LibraryParseError('parse.v2.idDuplicate', { n, id: question.id })
    }

    seenIds.add(question.id)

    // Nicht aktive Einträge werden nicht gespielt (Phase 2A kennt keine Replacement-Logik).
    if (question.status !== 'active') {
      return
    }

    const german = question.localized?.de
    const where = { n, id: question.id }

    if (!german || !isNonEmptyString(german.question)) {
      throw new LibraryParseError('parse.v2.germanQuestion', where)
    }

    if (!german.optionText || typeof german.optionText !== 'object') {
      throw new LibraryParseError('parse.v2.optionTextMissing', where)
    }

    OPTION_KEYS.forEach((key) => {
      if (!isNonEmptyString(german.optionText[key])) {
        throw new LibraryParseError('parse.v2.optionMissing', { ...where, key })
      }
    })

    const optionTexts = OPTION_KEYS.map((key) => german.optionText[key])

    if (new Set(optionTexts).size !== optionTexts.length) {
      throw new LibraryParseError('parse.v2.optionsNotUnique', where)
    }

    if (!OPTION_KEYS.includes(question.correctOptionKey)) {
      throw new LibraryParseError('parse.v2.correctOptionKey', where)
    }

    if (!Number.isInteger(question.contentRevision) || question.contentRevision < 1) {
      throw new LibraryParseError('parse.v2.contentRevision', where)
    }

    if (!isNonEmptyString(german.explanation)) {
      throw new LibraryParseError('parse.v2.germanExplanation', where)
    }

    // Phase 2E: der Lernabschnitt steht je Frage (`learningSectionId`), nicht auf Library-Ebene.
    sectionIds.add(question.learningSectionId)
    activeQuestions.push(toQuizQuestion(question, data.libraryId, languageIssues))
  })

  if (activeQuestions.length === 0) {
    throw new LibraryParseError('parse.v2.noActive')
  }

  if ([...sectionIds].some((id) => !isNonEmptyString(id) || !SECTION_ID_PATTERN.test(id))) {
    throw new LibraryParseError('parse.v2.sectionInvalid')
  }

  if (sectionIds.size !== 1) {
    throw new LibraryParseError('parse.v2.sectionsMixed', { count: sectionIds.size, ids: [...sectionIds].join(', ') })
  }

  const englishCount = activeQuestions.filter((question) => question.localized.en).length
  const declared = Array.isArray(data.languageSupport) ? data.languageSupport.filter((value) => ['de', 'en'].includes(value)) : ['de']

  return {
    library: {
      schemaVersion: data.schemaVersion,
      libraryId: data.libraryId,
      libraryVersion: data.libraryVersion,
      activeQuestionIndexHash: data.activeQuestionIndexHash,
      title: typeof data.title === 'string' ? data.title : data.libraryId,
      sourceSections: data.sourceSections ?? [],
      learningSectionId: [...sectionIds][0],
      questionCount: activeQuestions.length,
      // Phase 2F: deklarierte Sprachen und tatsächlich strukturell gültige Abdeckung (nur Zahlen).
      languageSupport: declared,
      contentCoverage: { de: activeQuestions.length, en: englishCount },
      languageIssues,
      // Revisionsstand je aktiver Frage (Basis für Update-Klassifikation; nur IDs und Zahlen).
      questionRevisions: Object.fromEntries(
        activeQuestions.map((question) => [question.id, question.contentRevision]),
      ),
    },
    questions: activeQuestions,
  }
}

// Arrays sind V1, Objekte sind V2. Es gibt keine automatische Umwandlung zwischen den Formaten.
export function parseQuestionFile(data) {
  if (Array.isArray(data)) {
    return { format: 'v1', library: null, questions: parseV1Questions(data) }
  }

  if (data !== null && typeof data === 'object') {
    // Ersetzungs-Index (retired-index.json): Objekt, dessen Schlüssel alle Question-IDs sind.
    const keys = Object.keys(data)

    if (keys.length > 0 && !('libraryId' in data) && !('questions' in data) && keys.every((key) => QUESTION_ID_PATTERN.test(key))) {
      return { format: 'retiredIndex', library: null, questions: [], retiredIndex: parseRetiredIndex(data) }
    }

    return { format: 'v2', ...parseV2Library(data) }
  }

  throw new LibraryParseError('parse.file.type')
}
