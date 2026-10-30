// IndexedDB-Persistenz für V2-Bibliotheken (Phase 2A).
//
// Drei getrennte Versionsbegriffe:
// - DB_VERSION             Version des IndexedDB-Schemas (Object Stores, Indizes)
// - STORAGE_SCHEMA_VERSION Version des Datenmodells in den Stores (meta-Eintrag)
// - libraryVersion         Version einer Fragebibliothek (steht in der Library-Datei)
//
// Gespeichert werden nur IDs, Zähler und Zeitstempel – nie Fragen, Optionstexte
// oder gewählte Antworten.

export const DB_NAME = 'cybersecurity-concepts-quiz'
export const DB_VERSION = 1
export const STORAGE_SCHEMA_VERSION = 1

const STORE_META = 'meta'
const STORE_LIBRARIES = 'libraries'
const STORE_PROGRESS = 'progress'
const INDEX_PROGRESS_BY_LIBRARY = 'byLibrary'
const META_SCHEMA_KEY = 'storageSchemaVersion'

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
    progress.createIndex(INDEX_PROGRESS_BY_LIBRARY, 'libraryId')
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
        .index(INDEX_PROGRESS_BY_LIBRARY)
        .getAll(libraryId),
    )
  }

  // Antwort-Ereignis: lesen, zählen und schreiben in einer einzigen Transaktion.
  async function recordAnswer({ libraryId, questionId, isCorrect, answeredAt = Date.now() }) {
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
    }

    progressStore.put(next)
    await transactionDone(transaction)

    return next
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
  }
}
