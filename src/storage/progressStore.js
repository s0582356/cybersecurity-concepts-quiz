// IndexedDB-Persistenz für V2-Bibliotheken (Phase 2A).
//
// Drei getrennte Versionsbegriffe:
// - DB_VERSION             Version des IndexedDB-Schemas (Object Stores, Indizes)
// - STORAGE_SCHEMA_VERSION Version des Datenmodells in den Stores (meta-Eintrag)
// - libraryVersion         Version einer Fragebibliothek (steht in der Library-Datei)
//
// Fortschritt/Rundenzustand: nur IDs, Zähler, Zeitstempel. Die Fragen selbst stehen ausschließlich
// im Store `libraryContent` (Phase 2E, lokal im Browser, nie hochgeladen).
//
// Phase 3B: neuer Object Store `examAttempts` (additiv, Prüfungsmodus). DB_VERSION steigt auf 4. Der Store ist
// vom Lernfortschritt vollständig getrennt: Prüfungsmethoden öffnen ausschließlich `examAttempts`, und kein
// Update-/Ersetzungspfad öffnet ihn. STORAGE_SCHEMA_VERSION bleibt 1 (bestehende Daten werden nicht migriert).
//
// Phase 2E: neuer Object Store `libraryContent` (additiv): die für die Lernabschnitts-Ansicht
// nötigen Fragen werden lokal im Browser abgelegt, damit nach einem Reload keine Datei mehr gewählt
// werden muss. DB_VERSION steigt auf 3; das Datenmodell der bestehenden Stores wird nur um optionale
// Felder erweitert (Library-State: title, learningSectionId, questionCount) – STORAGE_SCHEMA_VERSION
// bleibt 1. Der Library-Katalog ist aus dem Library-State abgeleitet und hat keinen eigenen Store.
//
// Phase 2B: neuer Object Store `sessions` (additiv). DB_VERSION steigt auf 2, weil nur
// dadurch der Store angelegt wird; das Datenmodell der bestehenden Stores bleibt
// unverändert, daher bleibt STORAGE_SCHEMA_VERSION = 1 (keine Datenmigration nötig).

import {
  advanceSession,
  applyAnswer,
  completeSession,
  migrateSessionReplacements,
  migrateSessionToLibrary,
} from '../domain/session.js'
import { LocalizedError, translate, msg } from '../i18n/index.js'
import { applyReplacementToProgress } from '../domain/replacementMigration.js'
import {
  EXAM_STATUS,
  applyExamAnswer,
  finalizeExamAttemptRecord,
  moveExamPosition,
  setExamPosition,
  validateExamAttempt,
} from '../domain/examAttempt.js'
import {
  isSectionSession,
  migrateSectionSessionReplacements,
  migrateSectionSessionToLibrary,
  sectionScopeKey,
} from '../domain/sectionSession.js'

export const DB_NAME = 'cybersecurity-concepts-quiz'
export const DB_VERSION = 4
export const STORAGE_SCHEMA_VERSION = 1

const STORE_META = 'meta'
const STORE_LIBRARIES = 'libraries'
const STORE_PROGRESS = 'progress'
const STORE_SESSIONS = 'sessions'
const STORE_CONTENT = 'libraryContent'
const STORE_EXAMS = 'examAttempts'
const INDEX_BY_LIBRARY = 'byLibrary'
const INDEX_BY_STATUS = 'byStatus'
const META_SCHEMA_KEY = 'storageSchemaVersion'
const META_RETIRED_INDEX_KEY = 'retiredIndex'

export class StorageUnavailableError extends Error {
  constructor(key, cause) {
    super(translate('de', key))
    this.name = 'StorageUnavailableError'
    this.i18n = msg(key)
    this.cause = cause
  }
}

export class StorageSchemaError extends Error {
  constructor(foundVersion) {
    const params = { found: String(foundVersion), supported: STORAGE_SCHEMA_VERSION }

    super(translate('de', 'err.storage.schema', params))
    this.name = 'StorageSchemaError'
    this.i18n = msg('err.storage.schema', params)
    this.foundVersion = foundVersion
  }
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error ?? new Error('Transaktion abgebrochen.'))
  })
}

function upgradeDatabase(database) {
  if (!database.objectStoreNames.contains(STORE_META)) {
    database.createObjectStore(STORE_META, { keyPath: 'key' })
  }

  if (!database.objectStoreNames.contains(STORE_LIBRARIES)) {
    database.createObjectStore(STORE_LIBRARIES, { keyPath: 'libraryId' })
  }

  if (!database.objectStoreNames.contains(STORE_PROGRESS)) {
    const progress = database.createObjectStore(STORE_PROGRESS, {
      keyPath: ['libraryId', 'questionId'],
    })
    progress.createIndex(INDEX_BY_LIBRARY, 'libraryId')
  }

  if (!database.objectStoreNames.contains(STORE_SESSIONS)) {
    const sessions = database.createObjectStore(STORE_SESSIONS, { keyPath: 'sessionId' })
    sessions.createIndex(INDEX_BY_LIBRARY, 'libraryId')
  }

  if (!database.objectStoreNames.contains(STORE_CONTENT)) {
    database.createObjectStore(STORE_CONTENT, { keyPath: 'libraryId' })
  }

  if (!database.objectStoreNames.contains(STORE_EXAMS)) {
    const exams = database.createObjectStore(STORE_EXAMS, { keyPath: 'examSessionId' })
    exams.createIndex(INDEX_BY_STATUS, 'status')
  }
}

// `onClosed` wird aufgerufen, wenn eine neuere Version dieser App (anderer Tab) ein Schema-Upgrade verlangt und
// diese Verbindung dafür geschlossen wird.
function openDatabase(factory, dbName, onClosed = () => {}) {
  return new Promise((resolve, reject) => {
    let request
    let settled = false

    try {
      request = factory.open(dbName, DB_VERSION)
    } catch (error) {
      reject(new StorageUnavailableError('err.storage.cannotOpen', error))
      return
    }

    request.onupgradeneeded = () => upgradeDatabase(request.result)
    // Eine ältere Verbindung (alter Tab/Build) hält das Upgrade auf: kontrolliert melden statt unbegrenzt warten.
    // Der Open-Request bleibt bestehen und schließt das Upgrade ab, sobald der alte Tab zu ist; diese dann nutzlose
    // Verbindung wird sofort wieder geschlossen (siehe onsuccess).
    request.onblocked = () => {
      if (!settled) {
        settled = true
        reject(new StorageUnavailableError('err.storage.blocked'))
      }
    }
    request.onsuccess = () => {
      const opened = request.result

      if (settled) {
        opened.close()
        return
      }

      // Künftige Upgrades dürfen nie an dieser Verbindung scheitern: bei `versionchange` schließen.
      opened.onversionchange = () => {
        opened.close()
        onClosed(opened)
      }
      settled = true
      resolve(opened)
    }
    request.onerror = () => {
      const { error } = request

      if (settled) {
        return
      }

      settled = true

      if (error?.name === 'VersionError') {
        // Die Datenbank wurde von einer neueren App-Version angelegt.
        reject(new StorageSchemaError(`DB-Version > ${DB_VERSION}`))
        return
      }

      reject(new StorageUnavailableError('err.storage.cannotOpen', error))
    }
  })
}

function abortQuietly(transaction) {
  try {
    transaction.abort()
  } catch {
    // Transaktion war bereits beendet
  }
}

function requireString(value, name) {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`${name} muss ein nicht leerer Text sein.`)
  }
}

export function createProgressStore({ indexedDB: factoryOverride, dbName = DB_NAME } = {}) {
  let database = null

  function db() {
    if (!database) {
      throw new StorageUnavailableError('err.storage.notInitialized')
    }

    return database
  }

  async function initialize() {
    if (database) {
      return
    }

    const factory = factoryOverride ?? globalThis.indexedDB

    if (!factory) {
      throw new StorageUnavailableError('err.storage.unavailable')
    }

    const opened = await openDatabase(factory, dbName, (closed) => {
      if (database === closed) {
        database = null
      }
    })
    const transaction = opened.transaction(STORE_META, 'readwrite')
    const metaStore = transaction.objectStore(STORE_META)
    const existing = await requestResult(metaStore.get(META_SCHEMA_KEY))

    if (existing === undefined) {
      metaStore.put({ key: META_SCHEMA_KEY, value: STORAGE_SCHEMA_VERSION })
    }

    await transactionDone(transaction)

    if (existing !== undefined && existing.value !== STORAGE_SCHEMA_VERSION) {
      opened.close()
      throw new StorageSchemaError(existing.value)
    }

    database = opened
  }

  function close() {
    database?.close()
    database = null
  }

  async function getStorageSchemaVersion() {
    const record = await requestResult(
      db().transaction(STORE_META).objectStore(STORE_META).get(META_SCHEMA_KEY),
    )

    return record?.value ?? null
  }

  async function getLibraryState(libraryId) {
    requireString(libraryId, 'libraryId')

    const record = await requestResult(
      db().transaction(STORE_LIBRARIES).objectStore(STORE_LIBRARIES).get(libraryId),
    )

    return record ?? null
  }

  function libraryStateRecord(state) {
    return {
      libraryId: state.libraryId,
      libraryVersion: state.libraryVersion,
      activeQuestionIndexHash: state.activeQuestionIndexHash,
      firstImportedAt: state.firstImportedAt,
      lastAccessedAt: state.lastAccessedAt,
      // additiv (Phase 2C): ältere Datensätze haben diese Felder nicht
      // plain copy: IndexedDB kann keine Vue-Proxys klonen
      ...(state.questionRevisions && { questionRevisions: { ...state.questionRevisions } }),
      ...(state.updatedAt != null && { updatedAt: state.updatedAt }),
      // additiv (Phase 2E): Katalog-Metadaten
      ...(state.title != null && { title: state.title }),
      ...(state.learningSectionId != null && { learningSectionId: state.learningSectionId }),
      ...(state.questionCount != null && { questionCount: state.questionCount }),
      // additiv (Phase 2F): deklarierte Sprachen und gezählte, strukturell gültige Abdeckung
      ...(state.languageSupport && { languageSupport: [...state.languageSupport] }),
      ...(state.contentCoverage && { contentCoverage: { de: state.contentCoverage.de, en: state.contentCoverage.en } }),
    }
  }

  function contentRecord(library, questions) {
    return {
      libraryId: library.libraryId,
      libraryVersion: library.libraryVersion,
      activeQuestionIndexHash: library.activeQuestionIndexHash,
      // plain copy: IndexedDB kann keine Vue-Proxys klonen
      questions: JSON.parse(JSON.stringify(questions)),
    }
  }

  // Optional `questions`: Library-State und Fragen werden gemeinsam (atomar) geschrieben.
  async function upsertLibraryState(state, { questions = null } = {}) {
    requireString(state?.libraryId, 'libraryId')
    requireString(state.libraryVersion, 'libraryVersion')
    requireString(state.activeQuestionIndexHash, 'activeQuestionIndexHash')

    const transaction = db().transaction(questions ? [STORE_LIBRARIES, STORE_CONTENT] : STORE_LIBRARIES, 'readwrite')
    transaction.objectStore(STORE_LIBRARIES).put(libraryStateRecord(state))

    if (questions) {
      transaction.objectStore(STORE_CONTENT).put(contentRecord(state, questions))
    }

    await transactionDone(transaction)

    return state
  }

  async function getLibraryContent(libraryId) {
    requireString(libraryId, 'libraryId')

    const record = await requestResult(db().transaction(STORE_CONTENT).objectStore(STORE_CONTENT).get(libraryId))

    return record ?? null
  }

  async function getQuestionProgress(libraryId, questionId) {
    requireString(libraryId, 'libraryId')
    requireString(questionId, 'questionId')

    const record = await requestResult(
      db().transaction(STORE_PROGRESS).objectStore(STORE_PROGRESS).get([libraryId, questionId]),
    )

    return record ?? null
  }

  async function upsertQuestionProgress(progress) {
    requireString(progress?.libraryId, 'libraryId')
    requireString(progress.questionId, 'questionId')

    const transaction = db().transaction(STORE_PROGRESS, 'readwrite')
    transaction.objectStore(STORE_PROGRESS).put({
      libraryId: progress.libraryId,
      questionId: progress.questionId,
      attempts: progress.attempts,
      correctCount: progress.correctCount,
      incorrectCount: progress.incorrectCount,
      lastResult: progress.lastResult,
      answered: progress.answered,
      lastAnsweredAt: progress.lastAnsweredAt,
      ...(progress.answeredAtRevision != null && { answeredAtRevision: progress.answeredAtRevision }),
      ...(progress.inheritedFrom && { inheritedFrom: progress.inheritedFrom }),
      ...(progress.historical && { historical: true, migratedTo: progress.migratedTo }),
    })
    await transactionDone(transaction)

    return progress
  }

  async function listProgressForLibrary(libraryId) {
    requireString(libraryId, 'libraryId')

    return requestResult(
      db()
        .transaction(STORE_PROGRESS)
        .objectStore(STORE_PROGRESS)
        .index(INDEX_BY_LIBRARY)
        .getAll(libraryId),
    )
  }

  async function listAllProgress() {
    return requestResult(db().transaction(STORE_PROGRESS).objectStore(STORE_PROGRESS).getAll())
  }

  // Antwort-Ereignis: lesen, zählen und schreiben in einer einzigen Transaktion.
  async function recordAnswer({
    libraryId,
    questionId,
    isCorrect,
    answeredAt = Date.now(),
    answeredAtRevision = null,
  }) {
    requireString(libraryId, 'libraryId')
    requireString(questionId, 'questionId')

    const transaction = db().transaction(STORE_PROGRESS, 'readwrite')
    const progressStore = transaction.objectStore(STORE_PROGRESS)
    const previous = await requestResult(progressStore.get([libraryId, questionId]))

    const next = {
      libraryId,
      questionId,
      attempts: (previous?.attempts ?? 0) + 1,
      correctCount: (previous?.correctCount ?? 0) + (isCorrect ? 1 : 0),
      incorrectCount: (previous?.incorrectCount ?? 0) + (isCorrect ? 0 : 1),
      lastResult: isCorrect ? 'correct' : 'incorrect',
      answered: true,
      lastAnsweredAt: answeredAt,
      ...(answeredAtRevision != null && { answeredAtRevision }),
      ...(previous?.inheritedFrom && { inheritedFrom: previous.inheritedFrom }),
    }

    progressStore.put(next)
    await transactionDone(transaction)

    return next
  }

  // --- Sessions (Phase 2B): höchstens eine Session je Bibliothek ---

  async function getLatestSession(libraryId) {
    requireString(libraryId, 'libraryId')

    const sessions = await requestResult(
      db()
        .transaction(STORE_SESSIONS)
        .objectStore(STORE_SESSIONS)
        .index(INDEX_BY_LIBRARY)
        .getAll(libraryId),
    )

    return sessions.sort((a, b) => b.sessionStartedAt - a.sessionStartedAt)[0] ?? null
  }

  // Ersetzt eine vorhandene (laufende oder abgeschlossene) Session der Bibliothek.
  // Dauerhafter Question Progress bleibt unberührt.
  async function startNewSession(session) {
    requireString(session?.sessionId, 'sessionId')
    requireString(session.libraryId, 'libraryId')

    const transaction = db().transaction(STORE_SESSIONS, 'readwrite')
    const sessionStore = transaction.objectStore(STORE_SESSIONS)
    const oldKeys = await requestResult(sessionStore.index(INDEX_BY_LIBRARY).getAllKeys(session.libraryId))

    oldKeys.forEach((key) => sessionStore.delete(key))
    sessionStore.put(session)
    await transactionDone(transaction)

    return session
  }

  // --- Abschnitts-Sessions (Phase 2E): höchstens eine Runde je Lernabschnitt (Scope-Key `section:<id>`) ---

  function getLatestSectionSession(sectionId) {
    requireString(sectionId, 'sectionId')

    return getLatestSession(sectionScopeKey(sectionId))
  }

  async function listSectionSessions() {
    const sessions = await requestResult(db().transaction(STORE_SESSIONS).objectStore(STORE_SESSIONS).getAll())

    return sessions.filter(isSectionSession)
  }

  async function updateSession(sessionId, transform) {
    requireString(sessionId, 'sessionId')

    const transaction = db().transaction(STORE_SESSIONS, 'readwrite')
    const sessionStore = transaction.objectStore(STORE_SESSIONS)
    const session = await requestResult(sessionStore.get(sessionId))

    if (!session) {
      transaction.abort()
      throw new LocalizedError('err.session.notFound')
    }

    const next = transform(session)
    sessionStore.put(next)
    await transactionDone(transaction)

    return next
  }

  function markSessionResumed(sessionId, resumedAt = Date.now()) {
    return updateSession(sessionId, (session) => ({ ...session, lastResumedAt: resumedAt }))
  }

  // Wechsel zur nächsten Frage; erst hier ändern sich currentQuestionId/currentIndex.
  function advanceSessionTo({ sessionId, questionId, optionOrder = null }) {
    return updateSession(sessionId, (session) => advanceSession(session, { questionId, optionOrder }))
  }

  // Ein erlaubter Sprachwechsel innerhalb der laufenden Runde (gleiche Fragenmenge): nur das Sprachfeld ändert sich.
  function setSessionLanguage(sessionId, sessionLanguage) {
    return updateSession(sessionId, (session) => ({ ...session, sessionLanguage }))
  }

  function completeSessionById(sessionId, completedAt = Date.now()) {
    return updateSession(sessionId, (session) => completeSession(session, completedAt))
  }

  // Antwort-Ereignis: Lebenszeit-Progress UND Session-Stand in EINER Transaktion über beide
  // Stores. Entweder beides oder nichts wird geschrieben; eine in der Session bereits
  // beantwortete Frage wird nie doppelt gezählt (auch nicht nach Reload/Wiederholung).
  async function recordSessionAnswer({
    sessionId,
    libraryId,
    questionId,
    isCorrect,
    selectedOptionKey = null,
    optionOrder = null,
    answeredAt = Date.now(),
    answeredAtRevision = null,
  }) {
    requireString(sessionId, 'sessionId')
    requireString(libraryId, 'libraryId')
    requireString(questionId, 'questionId')

    const transaction = db().transaction([STORE_PROGRESS, STORE_SESSIONS], 'readwrite')
    const sessionStore = transaction.objectStore(STORE_SESSIONS)
    const progressStore = transaction.objectStore(STORE_PROGRESS)
    const [session, previous] = await Promise.all([
      requestResult(sessionStore.get(sessionId)),
      requestResult(progressStore.get([libraryId, questionId])),
    ])

    // Library-Runde: gleiche Library. Abschnitts-Runde: die Frage muss laut Runde zu dieser Library gehören.
    const belongsToSession = isSectionSession(session)
      ? session.questionLibraries?.[questionId] === libraryId
      : session?.libraryId === libraryId
    const result = belongsToSession
      ? applyAnswer(session, { questionId, isCorrect, selectedOptionKey, optionOrder })
      : { applied: false, reason: 'noSession' }

    if (!result.applied) {
      await transactionDone(transaction)
      return { recorded: false, reason: result.reason }
    }

    const progress = {
      libraryId,
      questionId,
      attempts: (previous?.attempts ?? 0) + 1,
      correctCount: (previous?.correctCount ?? 0) + (isCorrect ? 1 : 0),
      incorrectCount: (previous?.incorrectCount ?? 0) + (isCorrect ? 0 : 1),
      lastResult: isCorrect ? 'correct' : 'incorrect',
      answered: true,
      lastAnsweredAt: answeredAt,
      ...(answeredAtRevision != null && { answeredAtRevision }),
      ...(previous?.inheritedFrom && { inheritedFrom: previous.inheritedFrom }),
    }

    progressStore.put(progress)
    sessionStore.put(result.session)
    await transactionDone(transaction)

    return { recorded: true, progress, session: result.session }
  }

  // --- Prüfungsversuche (Phase 3B) ---
  // Jede Methode öffnet ausschließlich den Store `examAttempts`: Lernfortschritt, Lernrunden, Library-States
  // und Library-Inhalte werden weder gelesen noch geschrieben. Mutationen laufen je in EINER Transaktion
  // (lesen, prüfen, schreiben); ein abgelehnter Aufruf schreibt nichts.

  const newestExamFirst = (a, b) => b.sessionStartedAt - a.sessionStartedAt

  // Plain copy: IndexedDB kann keine Vue-Proxys klonen.
  function examRecord(attempt) {
    return JSON.parse(JSON.stringify(attempt))
  }

  async function getExamAttempt(examSessionId) {
    requireString(examSessionId, 'examSessionId')

    const record = await requestResult(db().transaction(STORE_EXAMS).objectStore(STORE_EXAMS).get(examSessionId))

    return record ?? null
  }

  // Der (höchstens eine) laufende Versuch. Abgegebene Versuche werden nie als aktiv geliefert.
  async function getActiveExamAttempt() {
    const active = await requestResult(
      db()
        .transaction(STORE_EXAMS)
        .objectStore(STORE_EXAMS)
        .index(INDEX_BY_STATUS)
        .getAll(EXAM_STATUS.IN_PROGRESS),
    )

    return active.sort(newestExamFirst)[0] ?? null
  }

  async function listExamAttempts() {
    const attempts = await requestResult(db().transaction(STORE_EXAMS).objectStore(STORE_EXAMS).getAll())

    return attempts.sort(newestExamFirst)
  }

  // Schreibt einen neuen laufenden Versuch. Ein zweiter laufender Versuch wird abgelehnt (erst abgeben oder
  // verwerfen); eine vorhandene ID wird nie überschrieben.
  async function startExamAttempt(attempt) {
    const record = examRecord(attempt)
    const check = validateExamAttempt(record)

    if (!check.valid || record.status !== EXAM_STATUS.IN_PROGRESS) {
      return { started: false, reason: 'invalid', problems: check.problems }
    }

    const transaction = db().transaction(STORE_EXAMS, 'readwrite')
    const examStore = transaction.objectStore(STORE_EXAMS)
    const [activeCount, existing] = await Promise.all([
      requestResult(examStore.index(INDEX_BY_STATUS).count(EXAM_STATUS.IN_PROGRESS)),
      requestResult(examStore.get(record.examSessionId)),
    ])

    if (activeCount > 0 || existing) {
      await transactionDone(transaction)
      return { started: false, reason: existing ? 'duplicateId' : 'activeExists' }
    }

    examStore.put(record)
    await transactionDone(transaction)

    return { started: true, attempt: record }
  }

  // Lesen, Anwenden, Schreiben in einer Transaktion. `apply(record)` liefert { result, write }; `write` (neuer
  // Datensatz oder null) wird nur gespeichert, wenn die Änderung zulässig war.
  async function updateExamAttempt(examSessionId, onMissing, apply) {
    requireString(examSessionId, 'examSessionId')

    const transaction = db().transaction(STORE_EXAMS, 'readwrite')
    const examStore = transaction.objectStore(STORE_EXAMS)
    const record = await requestResult(examStore.get(examSessionId))

    if (!record) {
      await transactionDone(transaction)
      return onMissing
    }

    const { result, write } = apply(record)

    if (write) {
      examStore.put(examRecord(write))
    }

    await transactionDone(transaction)

    return result
  }

  // Antwort setzen/ersetzen (nur laufender Versuch, gültige Frage, gültiger Optionsschlüssel).
  function recordExamAnswer({ examSessionId, questionId, selectedOptionKey, now = Date.now() }) {
    return updateExamAttempt(examSessionId, { recorded: false, reason: 'notFound' }, (record) => {
      const outcome = applyExamAnswer(record, { questionId, selectedOptionKey, now })

      return outcome.applied
        ? { result: { recorded: true, attempt: outcome.attempt }, write: outcome.attempt }
        : { result: { recorded: false, reason: outcome.reason, attempt: record }, write: null }
    })
  }

  // Navigation: Ziel per `index` oder `questionId`, oder relativ per `direction` ('next' | 'previous').
  function setExamPositionTo({ examSessionId, index = null, questionId = null, direction = null, now = Date.now() }) {
    return updateExamAttempt(examSessionId, { moved: false, reason: 'notFound' }, (record) => {
      const outcome = direction
        ? moveExamPosition(record, direction, { now })
        : setExamPosition(record, { index, questionId, now })

      return outcome.applied
        ? { result: { moved: true, attempt: outcome.attempt }, write: outcome.attempt }
        : { result: { moved: false, reason: outcome.reason, attempt: record }, write: null }
    })
  }

  // Abgabe: Wertung und Statuswechsel atomar. Bereits abgegeben -> keine Änderung, derselbe Datensatz kommt zurück.
  function finalizeExamAttempt(examSessionId, now = Date.now()) {
    return updateExamAttempt(examSessionId, { finalized: false, reason: 'notFound' }, (record) => {
      const outcome = finalizeExamAttemptRecord(record, now)

      return outcome.finalized
        ? { result: { finalized: true, attempt: outcome.attempt }, write: outcome.attempt }
        : { result: { finalized: false, reason: outcome.reason, attempt: record }, write: null }
    })
  }

  // Phase 3D: bewusstes Verwerfen einer LAUFENDEN Prüfung und einziger Lösch-Pfad für Prüfungsversuche (die frühere,
  // bedingungslose `discardExamAttempt` wurde entfernt: sie hätte auch abgegebene Versuche gelöscht). Status prüfen
  // und löschen laufen in einer Transaktion: ein inzwischen (z. B. in einem anderen Tab) abgegebener Versuch bleibt
  // unverändert erhalten. Auch ein beschädigter laufender Datensatz ist verwerfbar (nur der Rohstatus zählt).
  async function discardActiveExamAttempt(examSessionId) {
    requireString(examSessionId, 'examSessionId')

    const transaction = db().transaction(STORE_EXAMS, 'readwrite')
    const examStore = transaction.objectStore(STORE_EXAMS)
    const existing = await requestResult(examStore.get(examSessionId))
    let outcome

    if (!existing) {
      outcome = { discarded: false, reason: 'notFound' }
    } else if (existing.status !== EXAM_STATUS.IN_PROGRESS) {
      outcome = { discarded: false, reason: 'notActive' }
    } else {
      examStore.delete(examSessionId)
      outcome = { discarded: true }
    }

    await transactionDone(transaction)

    return outcome
  }

  // --- Ersetzungs-Index (Phase 2D): nur IDs und Policies, kein Freitext ---

  async function getRetiredIndex() {
    const record = await requestResult(
      db().transaction(STORE_META).objectStore(STORE_META).get(META_RETIRED_INDEX_KEY),
    )

    return record?.entries ?? null
  }

  async function saveRetiredIndex(entries, importedAt = Date.now()) {
    const transaction = db().transaction(STORE_META, 'readwrite')

    transaction.objectStore(STORE_META).put({
      key: META_RETIRED_INDEX_KEY,
      entries: JSON.parse(JSON.stringify(entries)),
      importedAt,
    })
    await transactionDone(transaction)
  }

  async function listLibraryStates() {
    return requestResult(db().transaction(STORE_LIBRARIES).objectStore(STORE_LIBRARIES).getAll())
  }

  // Wendet Ersetzungen innerhalb einer laufenden Transaktion an (siehe applyReplacementToProgress).
  // Gelesene Datensätze werden vor dem Schreiben geprüft; ein Fehler bricht die Transaktion ab.
  async function migrateReplacements(progressObjectStore, sourceLibraryId, replacements, now) {
    const summary = []

    for (const replacement of [...replacements].sort((a, b) => a.from.localeCompare(b.from))) {
      const sourceKey = { libraryId: sourceLibraryId, questionId: replacement.from }
      const targetKey = { libraryId: replacement.targetLibraryId, questionId: replacement.to }
      const [source, target] = await Promise.all([
        requestResult(progressObjectStore.get([sourceKey.libraryId, sourceKey.questionId])),
        requestResult(progressObjectStore.get([targetKey.libraryId, targetKey.questionId])),
      ])
      const result = applyReplacementToProgress({
        source,
        target,
        policy: replacement.policy,
        sourceKey,
        targetKey,
        now,
      })

      if (result.source) {
        progressObjectStore.put(result.source)
      }

      if (result.target) {
        progressObjectStore.put(result.target)
      }

      summary.push({ from: replacement.from, to: replacement.to, outcome: result.outcome })
    }

    return summary
  }

  // Eigenständige, idempotente Ersetzung (zweiter Lauf: alles `alreadyMigrated`, keine Änderung).
  async function applyReplacementMigration({ libraryId, replacements, now = Date.now() }) {
    requireString(libraryId, 'libraryId')

    const transaction = db().transaction(STORE_PROGRESS, 'readwrite')

    try {
      const summary = await migrateReplacements(transaction.objectStore(STORE_PROGRESS), libraryId, replacements, now)

      await transactionDone(transaction)

      return summary
    } catch (error) {
      abortQuietly(transaction)
      throw error
    }
  }

  // Bestätigte Übernahme einer kompatiblen Library-Änderung: Library-State, Ersetzungen und – wenn
  // sicher möglich – die laufende Runde in EINER Transaktion. Bei jedem Fehler wird alles verworfen.
  async function applyCompatibleUpdate({
    library,
    previousHash,
    revisedQuestionIds = [],
    replacements = [],
    questions = null,
    now = Date.now(),
  }) {
    requireString(library?.libraryId, 'libraryId')

    const transaction = db().transaction([STORE_LIBRARIES, STORE_SESSIONS, STORE_PROGRESS, STORE_CONTENT], 'readwrite')

    try {
      const libraryStore = transaction.objectStore(STORE_LIBRARIES)
      const sessionStore = transaction.objectStore(STORE_SESSIONS)
      const [known, sessions] = await Promise.all([
        requestResult(libraryStore.get(library.libraryId)),
        requestResult(sessionStore.index(INDEX_BY_LIBRARY).getAll(library.libraryId)),
      ])

      if (!known || known.activeQuestionIndexHash !== previousHash) {
        throw new LocalizedError('err.update.stateChanged')
      }

      const migrated = await migrateReplacements(
        transaction.objectStore(STORE_PROGRESS),
        library.libraryId,
        replacements,
        now,
      )
      const session = sessions.sort((a, b) => b.sessionStartedAt - a.sessionStartedAt)[0]
      let migration = { migrated: false }

      if (session) {
        migration =
          replacements.length > 0
            ? migrateSessionReplacements(session, library, replacements, revisedQuestionIds)
            : migrateSessionToLibrary(session, library, revisedQuestionIds)
      }

      libraryStore.put({
        ...known,
        libraryVersion: library.libraryVersion,
        activeQuestionIndexHash: library.activeQuestionIndexHash,
        questionRevisions: { ...library.questionRevisions },
        lastAccessedAt: now,
        updatedAt: now,
        ...(library.title != null && { title: library.title }),
        ...(library.learningSectionId != null && { learningSectionId: library.learningSectionId }),
        ...(library.questionCount != null && { questionCount: library.questionCount }),
        ...(library.languageSupport && { languageSupport: [...library.languageSupport] }),
        ...(library.contentCoverage && { contentCoverage: { de: library.contentCoverage.de, en: library.contentCoverage.en } }),
      })

      if (migration.migrated) {
        sessionStore.put(migration.session)
      }

      // Phase 2E: Fragen des neuen Stands und laufende Abschnitts-Runden, die Fragen dieser Library enthalten.
      if (questions) {
        transaction.objectStore(STORE_CONTENT).put(contentRecord(library, questions))
      }

      const sectionId = library.learningSectionId ?? known.learningSectionId
      const sectionSessions = (await requestResult(sessionStore.getAll())).filter(
        (candidate) => isSectionSession(candidate) && candidate.sectionId === sectionId,
      )
      const sectionLibraries = [
        ...(await requestResult(libraryStore.getAll())).filter(
          (state) => state.libraryId !== library.libraryId && state.learningSectionId === sectionId && state.questionRevisions,
        ),
        library,
      ]

      sectionSessions.forEach((sectionSession) => {
        const sectionMigration =
          replacements.length > 0
            ? migrateSectionSessionReplacements(sectionSession, sectionLibraries, replacements, revisedQuestionIds)
            : migrateSectionSessionToLibrary(sectionSession, library, revisedQuestionIds)

        if (sectionMigration.migrated) {
          sessionStore.put(sectionMigration.session)
        }
      })

      await transactionDone(transaction)

      return {
        libraryState: { ...known, libraryVersion: library.libraryVersion, activeQuestionIndexHash: library.activeQuestionIndexHash },
        sessionMigrated: migration.migrated,
        replacements: migrated,
      }
    } catch (error) {
      abortQuietly(transaction)
      throw error
    }
  }

  return {
    initialize,
    close,
    getStorageSchemaVersion,
    getLibraryState,
    upsertLibraryState,
    getQuestionProgress,
    upsertQuestionProgress,
    listProgressForLibrary,
    recordAnswer,
    getLatestSession,
    getLibraryContent,
    listAllProgress,
    getLatestSectionSession,
    listSectionSessions,
    startNewSession,
    markSessionResumed,
    advanceSessionTo,
    completeSessionById,
    setSessionLanguage,
    recordSessionAnswer,
    applyCompatibleUpdate,
    applyReplacementMigration,
    getRetiredIndex,
    saveRetiredIndex,
    listLibraryStates,
    getExamAttempt,
    getActiveExamAttempt,
    listExamAttempts,
    startExamAttempt,
    recordExamAnswer,
    setExamPosition: setExamPositionTo,
    finalizeExamAttempt,
    discardActiveExamAttempt,
  }
}
