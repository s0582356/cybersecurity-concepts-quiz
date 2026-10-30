// IndexedDB-Persistenz für V2-Bibliotheken (Phase 2A).
//
// Drei getrennte Versionsbegriffe:
// - DB_VERSION             Version des IndexedDB-Schemas (Object Stores, Indizes)
// - STORAGE_SCHEMA_VERSION Version des Datenmodells in den Stores (meta-Eintrag)
// - libraryVersion         Version einer Fragebibliothek (steht in der Library-Datei)
//
// Gespeichert werden nur IDs, Zähler, Zeitstempel und Rundenzustand – nie Fragen,
// Optionstexte oder Erklärungen.
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
import { applyReplacementToProgress } from '../domain/replacementMigration.js'

export const DB_NAME = 'cybersecurity-concepts-quiz'
export const DB_VERSION = 2
export const STORAGE_SCHEMA_VERSION = 1

const STORE_META = 'meta'
const STORE_LIBRARIES = 'libraries'
const STORE_PROGRESS = 'progress'
const STORE_SESSIONS = 'sessions'
const INDEX_BY_LIBRARY = 'byLibrary'
const META_SCHEMA_KEY = 'storageSchemaVersion'
const META_RETIRED_INDEX_KEY = 'retiredIndex'

export class StorageUnavailableError extends Error {
  constructor(message, cause) {
    super(message)
    this.name = 'StorageUnavailableError'
    this.cause = cause
  }
}

export class StorageSchemaError extends Error {
  constructor(foundVersion) {
    super(
      `Der lokale Speicher hat eine unbekannte Version (${String(foundVersion)}). ` +
        `Diese App-Version unterstützt storageSchemaVersion ${STORAGE_SCHEMA_VERSION}.`,
    )
    this.name = 'StorageSchemaError'
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
}

function openDatabase(factory, dbName) {
  return new Promise((resolve, reject) => {
    let request

    try {
      request = factory.open(dbName, DB_VERSION)
    } catch (error) {
      reject(new StorageUnavailableError('IndexedDB konnte nicht geöffnet werden.', error))
      return
    }

    request.onupgradeneeded = () => upgradeDatabase(request.result)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => {
      const { error } = request

      if (error?.name === 'VersionError') {
        // Die Datenbank wurde von einer neueren App-Version angelegt.
        reject(new StorageSchemaError(`DB-Version > ${DB_VERSION}`))
        return
      }

      reject(new StorageUnavailableError('IndexedDB konnte nicht geöffnet werden.', error))
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
      throw new StorageUnavailableError('Der lokale Speicher ist nicht initialisiert.')
    }

    return database
  }

  async function initialize() {
    if (database) {
      return
    }

    const factory = factoryOverride ?? globalThis.indexedDB

    if (!factory) {
      throw new StorageUnavailableError('IndexedDB ist in diesem Browser nicht verfügbar.')
    }

    const opened = await openDatabase(factory, dbName)
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

  async function upsertLibraryState(state) {
    requireString(state?.libraryId, 'libraryId')
    requireString(state.libraryVersion, 'libraryVersion')
    requireString(state.activeQuestionIndexHash, 'activeQuestionIndexHash')

    const transaction = db().transaction(STORE_LIBRARIES, 'readwrite')
    transaction.objectStore(STORE_LIBRARIES).put({
      libraryId: state.libraryId,
      libraryVersion: state.libraryVersion,
      activeQuestionIndexHash: state.activeQuestionIndexHash,
      firstImportedAt: state.firstImportedAt,
      lastAccessedAt: state.lastAccessedAt,
      // additiv (Phase 2C): ältere Datensätze haben diese Felder nicht
      // plain copy: IndexedDB kann keine Vue-Proxys klonen
      ...(state.questionRevisions && { questionRevisions: { ...state.questionRevisions } }),
      ...(state.updatedAt != null && { updatedAt: state.updatedAt }),
    })
    await transactionDone(transaction)

    return state
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

  async function updateSession(sessionId, transform) {
    requireString(sessionId, 'sessionId')

    const transaction = db().transaction(STORE_SESSIONS, 'readwrite')
    const sessionStore = transaction.objectStore(STORE_SESSIONS)
    const session = await requestResult(sessionStore.get(sessionId))

    if (!session) {
      transaction.abort()
      throw new Error('Session nicht gefunden.')
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

    const result = session?.libraryId === libraryId
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
    now = Date.now(),
  }) {
    requireString(library?.libraryId, 'libraryId')

    const transaction = db().transaction([STORE_LIBRARIES, STORE_SESSIONS, STORE_PROGRESS], 'readwrite')

    try {
      const libraryStore = transaction.objectStore(STORE_LIBRARIES)
      const sessionStore = transaction.objectStore(STORE_SESSIONS)
      const [known, sessions] = await Promise.all([
        requestResult(libraryStore.get(library.libraryId)),
        requestResult(sessionStore.index(INDEX_BY_LIBRARY).getAll(library.libraryId)),
      ])

      if (!known || known.activeQuestionIndexHash !== previousHash) {
        throw new Error('Der gespeicherte Stand hat sich geändert.')
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
      })

      if (migration.migrated) {
        sessionStore.put(migration.session)
      }

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
    startNewSession,
    markSessionResumed,
    advanceSessionTo,
    completeSessionById,
    recordSessionAnswer,
    applyCompatibleUpdate,
    applyReplacementMigration,
    getRetiredIndex,
    saveRetiredIndex,
    listLibraryStates,
  }
}
