// Sprachschicht für Frageninhalte (Phase 2F).
//
// Eine Frage hat genau eine ID, einen `correctOptionKey` und stabile Optionsschlüssel a–d (alles sprachunabhängig,
// siehe SECURITY_DE_EN_CONTENT_CONTRACT). Nur die Texte liegen je Sprache in `localized.<lang>`:
// question, optionText{a–d}, explanation, memoryAid{type,text}. Es gibt keine Übersetzung zur Laufzeit.
//
// Zugriff auf Texte läuft ausschließlich über `resolveQuestionContent` / `presentQuestion`.
// Ob Englisch "verfügbar" ist, entscheidet die Struktur (validateLocalizedContent), nicht `languageSupport`.

export const OPTION_KEYS = ['a', 'b', 'c', 'd']
export const CONTENT_LOCALES = ['de', 'en']
export const DEFAULT_CONTENT_LOCALE = 'de'

// Sprachmodi für Englisch (DE/EN-Contract, Fallback-Policy): Standard "Nur Englisch" und Opt-in "Alle verfügbaren Fragen".
export const LANGUAGE_MODE = {
  ONLY_ENGLISH: 'onlyEnglish',
  ALL_AVAILABLE: 'allAvailable',
}

// Geschlossene Enum laut SECURITY_QUESTION_SCHEMA_V2 (`memoryAid.type`).
export const MEMORY_AID_TYPES = [
  'mnemonic',
  'confusion',
  'exam_trap',
  'practice_anchor',
  'contrast',
  'mini_scenario',
  'rule_of_thumb',
]

function isText(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export const CONTENT_PROBLEM = {
  MISSING: 'missing',
  NOT_AN_OBJECT: 'notAnObject',
  QUESTION: 'questionText',
  OPTIONS_MISSING: 'optionsMissing',
  OPTION_KEYS: 'optionKeys',
  OPTION_TEXT: 'optionText',
  OPTIONS_NOT_UNIQUE: 'optionsNotUnique',
  EXPLANATION: 'explanation',
  MEMORY_AID: 'memoryAid',
}

// Strukturprüfung einer lokalisierten Fassung. Die Optionsschlüssel müssen exakt a–d sein (kein Mapping).
// `requireMemoryAid` (Englisch): `memoryAid` ist laut V2-Schema Pflicht in jeder lokalisierten Fassung, mit
// `type` aus der geschlossenen Enum und nichtleerem `text`. Ohne die Option (deutsche Basisansicht, ältere
// gespeicherte Inhalte) ist memoryAid optional, muss aber wohlgeformt sein, wenn vorhanden.
export function validateLocalizedContent(content, { requireMemoryAid = false } = {}) {
  if (content === null || content === undefined) {
    return { valid: false, problem: CONTENT_PROBLEM.MISSING }
  }

  if (!isPlainObject(content)) {
    return { valid: false, problem: CONTENT_PROBLEM.NOT_AN_OBJECT }
  }

  if (!isText(content.question)) {
    return { valid: false, problem: CONTENT_PROBLEM.QUESTION }
  }

  if (!isPlainObject(content.optionText)) {
    return { valid: false, problem: CONTENT_PROBLEM.OPTIONS_MISSING }
  }

  const keys = Object.keys(content.optionText).sort()

  if (keys.length !== OPTION_KEYS.length || keys.some((key, index) => key !== OPTION_KEYS[index])) {
    return { valid: false, problem: CONTENT_PROBLEM.OPTION_KEYS }
  }

  if (OPTION_KEYS.some((key) => !isText(content.optionText[key]))) {
    return { valid: false, problem: CONTENT_PROBLEM.OPTION_TEXT }
  }

  if (new Set(OPTION_KEYS.map((key) => content.optionText[key])).size !== OPTION_KEYS.length) {
    return { valid: false, problem: CONTENT_PROBLEM.OPTIONS_NOT_UNIQUE }
  }

  if (!isText(content.explanation)) {
    return { valid: false, problem: CONTENT_PROBLEM.EXPLANATION }
  }

  const aid = content.memoryAid

  if (aid === undefined || aid === null) {
    return requireMemoryAid ? { valid: false, problem: CONTENT_PROBLEM.MEMORY_AID } : { valid: true, problem: null }
  }

  if (!isPlainObject(aid) || !isText(aid.text) || (requireMemoryAid && !MEMORY_AID_TYPES.includes(aid.type))) {
    return { valid: false, problem: CONTENT_PROBLEM.MEMORY_AID }
  }

  return { valid: true, problem: null }
}

// Englisch gilt nur mit allen Pflichtfeldern des Schemas (inkl. memoryAid).
export function validateEnglishContent(content) {
  return validateLocalizedContent(content, { requireMemoryAid: true })
}

// Bereinigte, speicherbare Fassung (nur bekannte Felder; memoryAid optional).
export function normalizeLocalizedContent(content) {
  const memoryAid = isText(content.memoryAid?.text)
    ? { type: typeof content.memoryAid.type === 'string' ? content.memoryAid.type : null, text: content.memoryAid.text }
    : null

  return {
    question: content.question,
    optionText: Object.fromEntries(OPTION_KEYS.map((key) => [key, content.optionText[key]])),
    explanation: content.explanation,
    memoryAid,
  }
}

// Gespeicherte Fragen aus Phase 2E enthalten nur die flache deutsche Ansicht; daraus wird `localized.de` abgeleitet.
export function normalizeStoredQuestion(question) {
  if (question.localized || !question.optionTextByKey) {
    return question
  }

  const correctOptionKey =
    question.correctOptionKey ?? OPTION_KEYS.find((key) => question.optionTextByKey[key] === question.correctAnswer) ?? null

  return {
    ...question,
    correctOptionKey,
    localized: {
      de: {
        question: question.question,
        optionText: { ...question.optionTextByKey },
        explanation: question.explanation,
        memoryAid: null,
      },
      en: null,
    },
  }
}

export function isLocalizedQuestion(question) {
  return Boolean(question?.localized?.de)
}

export function hasValidEnglish(question) {
  return validateEnglishContent(question?.localized?.en).valid
}

// Wählt den Text einer Sprache. Ohne gültige Fassung in der Wunschsprache: deutsche Fassung, markiert als Fallback.
// Unbekannte Sprachschlüssel werden wie "nicht vorhanden" behandelt (kein Absturz).
export function resolveQuestionContent(question, locale) {
  const wanted = CONTENT_LOCALES.includes(locale) ? locale : DEFAULT_CONTENT_LOCALE
  const wantedContent = question?.localized?.[wanted]
  const wantedCheck = wanted === 'en' ? validateEnglishContent(wantedContent) : validateLocalizedContent(wantedContent)

  if (wantedCheck.valid) {
    return { language: wanted, fallback: locale !== undefined && locale !== wanted, content: wantedContent }
  }

  // Fallback = die angeforderte Sprache (auch ein unbekannter Schlüssel) wurde nicht geliefert.
  return {
    language: DEFAULT_CONTENT_LOCALE,
    fallback: locale !== undefined && locale !== DEFAULT_CONTENT_LOCALE,
    content: question?.localized?.de ?? null,
  }
}

// Flache Anzeigeform, wie die UI sie erwartet. `optionOrder` sind Schlüssel (a–d): so bleibt die Reihenfolge einer
// bereits angezeigten Frage beim Sprachwechsel exakt erhalten. Fragen ohne `localized` (V1, öffentliche Beispiele)
// bleiben unverändert.
export function presentQuestion(question, locale, { optionOrder = null } = {}) {
  if (!isLocalizedQuestion(question)) {
    return question
  }

  const { language, fallback, content } = resolveQuestionContent(question, locale)
  const order = isValidOrder(optionOrder) ? optionOrder : OPTION_KEYS

  return {
    ...question,
    question: content.question,
    options: order.map((key) => content.optionText[key]),
    correctAnswer: content.optionText[question.correctOptionKey],
    explanation: content.explanation,
    memoryAid: content.memoryAid ?? null,
    optionTextByKey: { ...content.optionText },
    contentLanguage: language,
    // Sichtbar markierter Fallback (Modus "Alle verfügbaren Fragen"): gewünschte Sprache wurde nicht geliefert.
    languageFallback: fallback,
  }
}

function isValidOrder(order) {
  return Array.isArray(order) && order.length === OPTION_KEYS.length && [...order].sort().join('') === OPTION_KEYS.join('')
}

// Schlüsselreihenfolge der aktuell angezeigten Optionen (aus der flachen Ansicht rekonstruiert).
export function displayedOptionOrder(view) {
  if (!view?.optionTextByKey) {
    return null
  }

  const order = view.options.map((text) => OPTION_KEYS.find((key) => view.optionTextByKey[key] === text))

  return isValidOrder(order) ? order : null
}

// Gleiche Frage, andere Sprache: Reihenfolge der Optionen bleibt (Schlüssel), nur die Texte wechseln.
export function relocalizeQuestion(view, locale) {
  if (!isLocalizedQuestion(view)) {
    return view
  }

  return presentQuestion(view, locale, { optionOrder: displayedOptionOrder(view) })
}

// Abdeckung einer Fragenliste: wie viele Fragen haben gültiges Deutsch/Englisch (Struktur geprüft).
export function coverageOf(questions) {
  const total = questions.length
  const german = questions.filter((question) => validateLocalizedContent(question.localized?.de).valid).length
  const english = questions.filter(hasValidEnglish).length

  return { total, de: german, en: english, englishComplete: total > 0 && english === total }
}

// Fragenmenge einer neuen Runde (DE/EN-Contract, Fallback-Policy). Rein; die Reihenfolge wird erst danach gemischt.
// - Deutsch: alle Fragen des Abschnitts.
// - Englisch, "Nur Englisch": nur Fragen mit gültigem EN; ausgelassene IDs werden gemeldet.
// - Englisch, "Alle verfügbaren Fragen": alle Fragen; ohne EN erscheint die deutsche Fassung sichtbar markiert.
export function planRoundQuestions(questions, { language = 'de', mode = LANGUAGE_MODE.ONLY_ENGLISH } = {}) {
  if (language !== 'en') {
    return { language: 'de', mode: null, questions, skippedQuestionIds: [] }
  }

  if (mode === LANGUAGE_MODE.ALL_AVAILABLE) {
    return { language: 'en', mode, questions, skippedQuestionIds: [] }
  }

  const english = questions.filter(hasValidEnglish)

  return {
    language: 'en',
    mode: LANGUAGE_MODE.ONLY_ENGLISH,
    questions: english,
    skippedQuestionIds: questions.filter((question) => !hasValidEnglish(question)).map((question) => question.id),
  }
}

// Kann eine laufende Runde (feste ID-Menge) in der Sprache dargestellt werden, ohne ihre Menge zu ändern?
// Deutsch immer; Englisch nur, wenn jede Rundenfrage gültiges EN hat oder die Runde im Modus "Alle verfügbaren" läuft.
export function canPresentRound(questions, { language, mode }) {
  if (language !== 'en') {
    return { possible: true, missing: 0 }
  }

  const missing = questions.filter((question) => !hasValidEnglish(question)).length

  return { possible: missing === 0 || mode === LANGUAGE_MODE.ALL_AVAILABLE, missing }
}
