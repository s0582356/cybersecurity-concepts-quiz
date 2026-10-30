// Parsing und Validierung geladener Fragedateien.
//
// V1: flaches Array von Fragen (bestehendes Format, unverändert).
// V2: Library-Objekt mit Metadaten und `questions[]` (siehe SECURITY_QUESTION_SCHEMA_V2).
//
// Der V2-Pfad prüft nur das, was die App für Phase 2A braucht; er ersetzt keinen
// vollständigen Schema-Validator.

export class LibraryParseError extends Error {
  constructor(message) {
    super(message)
    this.name = 'LibraryParseError'
  }
}

const SUPPORTED_V2_SCHEMA = /^2\.\d+\.\d+$/
const LIBRARY_ID_PATTERN = /^[a-z0-9-]{3,64}$/
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/
const QUESTION_ID_PATTERN = /^sec-a\d{2}-\d{4}$/
const OPTION_KEYS = ['a', 'b', 'c', 'd']

export function parseV1Questions(data) {
  if (!Array.isArray(data)) {
    throw new LibraryParseError('Die JSON-Datei muss ein Array von Fragen enthalten.')
  }

  if (data.length === 0) {
    throw new LibraryParseError('Die JSON-Datei enthält keine Fragen.')
  }

  data.forEach((question, index) => {
    if (!question.question || typeof question.question !== 'string') {
      throw new LibraryParseError(`Frage ${index + 1}: "question" fehlt oder ist ungültig.`)
    }

    if (!Array.isArray(question.options) || question.options.length < 2) {
      throw new LibraryParseError(`Frage ${index + 1}: "options" muss mindestens zwei Antworten enthalten.`)
    }

    if (!question.correctAnswer || typeof question.correctAnswer !== 'string') {
      throw new LibraryParseError(`Frage ${index + 1}: "correctAnswer" fehlt oder ist ungültig.`)
    }

    if (!question.options.includes(question.correctAnswer)) {
      throw new LibraryParseError(`Frage ${index + 1}: "correctAnswer" muss in "options" enthalten sein.`)
    }

    if (!question.explanation || typeof question.explanation !== 'string') {
      throw new LibraryParseError(`Frage ${index + 1}: "explanation" fehlt oder ist ungültig.`)
    }

    if (question.category !== undefined && typeof question.category !== 'string') {
      throw new LibraryParseError(`Frage ${index + 1}: "category" muss ein Text sein.`)
    }

    if (question.difficulty !== undefined && typeof question.difficulty !== 'string') {
      throw new LibraryParseError(`Frage ${index + 1}: "difficulty" muss ein Text sein.`)
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

function toQuizQuestion(question, libraryId) {
  const german = question.localized.de
  const options = OPTION_KEYS.map((key) => german.optionText[key])

  return {
    // Persistenter Schlüssel ist (libraryId, id); der Fragetext spielt keine Rolle.
    id: question.id,
    libraryId,
    category: question.topicId || question.learningSectionId || 'Allgemein',
    difficulty: question.difficulty || 'medium',
    question: german.question,
    options,
    correctAnswer: german.optionText[question.correctOptionKey],
    explanation: german.explanation,
    contentRevision: question.contentRevision,
    // Keys a–d sind lokal zur Frage; nur für Optionsreihenfolge/Auswahl innerhalb derselben Frage.
    optionTextByKey: Object.fromEntries(OPTION_KEYS.map((key) => [key, german.optionText[key]])),
  }
}

export function parseV2Library(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new LibraryParseError('Eine V2-Library muss ein JSON-Objekt sein.')
  }

  if (!isNonEmptyString(data.schemaVersion)) {
    throw new LibraryParseError('V2-Library: "schemaVersion" fehlt.')
  }

  if (!SUPPORTED_V2_SCHEMA.test(data.schemaVersion)) {
    throw new LibraryParseError(`V2-Library: schemaVersion "${data.schemaVersion}" wird nicht unterstützt.`)
  }

  if (!isNonEmptyString(data.libraryId) || !LIBRARY_ID_PATTERN.test(data.libraryId)) {
    throw new LibraryParseError('V2-Library: "libraryId" fehlt oder ist ungültig.')
  }

  if (!isNonEmptyString(data.libraryVersion) || !SEMVER_PATTERN.test(data.libraryVersion)) {
    throw new LibraryParseError('V2-Library: "libraryVersion" fehlt oder ist ungültig.')
  }

  if (!isNonEmptyString(data.activeQuestionIndexHash) || !HASH_PATTERN.test(data.activeQuestionIndexHash)) {
    throw new LibraryParseError('V2-Library: "activeQuestionIndexHash" fehlt oder ist ungültig.')
  }

  if (!Array.isArray(data.questions)) {
    throw new LibraryParseError('V2-Library: "questions" muss ein Array sein.')
  }

  if (data.questions.length === 0) {
    throw new LibraryParseError('V2-Library: "questions" enthält keine Fragen.')
  }

  if (data.questionCount !== undefined && data.questionCount !== data.questions.length) {
    throw new LibraryParseError('V2-Library: "questionCount" passt nicht zur Anzahl der Fragen.')
  }

  if (data.sourceSections !== undefined && !Array.isArray(data.sourceSections)) {
    throw new LibraryParseError('V2-Library: "sourceSections" muss ein Array sein.')
  }

  if (Array.isArray(data.languageSupport) && !data.languageSupport.includes('de')) {
    throw new LibraryParseError('V2-Library: deutsche Inhalte ("de") fehlen in "languageSupport".')
  }

  const seenIds = new Set()
  const activeQuestions = []

  data.questions.forEach((question, index) => {
    const label = `V2-Frage ${index + 1}`

    if (question === null || typeof question !== 'object') {
      throw new LibraryParseError(`${label}: ungültiger Eintrag.`)
    }

    if (!isNonEmptyString(question.id) || !QUESTION_ID_PATTERN.test(question.id)) {
      throw new LibraryParseError(`${label}: "id" fehlt oder ist ungültig.`)
    }

    if (seenIds.has(question.id)) {
      throw new LibraryParseError(`${label}: doppelte Question-ID "${question.id}".`)
    }

    seenIds.add(question.id)

    // Nicht aktive Einträge werden nicht gespielt (Phase 2A kennt keine Replacement-Logik).
    if (question.status !== 'active') {
      return
    }

    const german = question.localized?.de

    if (!german || !isNonEmptyString(german.question)) {
      throw new LibraryParseError(`${label} (${question.id}): deutscher Fragetext fehlt.`)
    }

    if (!german.optionText || typeof german.optionText !== 'object') {
      throw new LibraryParseError(`${label} (${question.id}): "optionText" fehlt.`)
    }

    OPTION_KEYS.forEach((key) => {
      if (!isNonEmptyString(german.optionText[key])) {
        throw new LibraryParseError(`${label} (${question.id}): Option "${key}" fehlt.`)
      }
    })

    const optionTexts = OPTION_KEYS.map((key) => german.optionText[key])

    if (new Set(optionTexts).size !== optionTexts.length) {
      throw new LibraryParseError(`${label} (${question.id}): Optionstexte sind nicht eindeutig.`)
    }

    if (!OPTION_KEYS.includes(question.correctOptionKey)) {
      throw new LibraryParseError(`${label} (${question.id}): "correctOptionKey" ist ungültig.`)
    }

    if (!Number.isInteger(question.contentRevision) || question.contentRevision < 1) {
      throw new LibraryParseError(`${label} (${question.id}): "contentRevision" fehlt oder ist ungültig.`)
    }

    if (!isNonEmptyString(german.explanation)) {
      throw new LibraryParseError(`${label} (${question.id}): deutsche Erklärung fehlt.`)
    }

    activeQuestions.push(toQuizQuestion(question, data.libraryId))
  })

  if (activeQuestions.length === 0) {
    throw new LibraryParseError('V2-Library: keine aktiven Fragen enthalten.')
  }

  return {
    library: {
      schemaVersion: data.schemaVersion,
      libraryId: data.libraryId,
      libraryVersion: data.libraryVersion,
      activeQuestionIndexHash: data.activeQuestionIndexHash,
      title: typeof data.title === 'string' ? data.title : data.libraryId,
      sourceSections: data.sourceSections ?? [],
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
    return { format: 'v2', ...parseV2Library(data) }
  }

  throw new LibraryParseError('Die JSON-Datei muss ein Array von Fragen oder eine V2-Library enthalten.')
}
