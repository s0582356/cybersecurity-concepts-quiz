// Aktualisierungserinnerung für lokal gespeicherte Libraries.
//
// Die Libraries bleiben im Browser (IndexedDB). Der globale Zeitpunkt (Meta-Eintrag `lastSuccessfulLibraryImportAt`) wird
// NUR nach einem vollständigen, sauberen Refresh erneuert (siehe isCompleteCleanRefresh); ab LIBRARY_REFRESH_INTERVAL_DAYS
// Tagen erscheint ein nicht-blockierender Hinweis. Es wird nichts gelöscht, deaktiviert oder gesperrt – nur eine Empfehlung.
import { BATCH_STATUS } from '../domain/libraryCatalog.js'
import { resultSeverity } from './catalogImport.js'

export const LIBRARY_REFRESH_INTERVAL_DAYS = 30

const DAY_MS = 24 * 60 * 60 * 1000

export const LIBRARY_REFRESH_INTERVAL_MS = LIBRARY_REFRESH_INTERVAL_DAYS * DAY_MS

// Herkunft des Zeitpunkts: echter vollständiger Refresh oder nur Startpunkt der Erinnerung (Baseline, Importdatum unbekannt).
export const REFRESH_ORIGIN = { IMPORT: 'import', BASELINE: 'baseline' }

const LIBRARY_OK_STATUSES = [BATCH_STATUS.NEW, BATCH_STATUS.KNOWN, BATCH_STATUS.VERSION_UPDATED]

const isTimestamp = (value) => Number.isFinite(value) && value > 0

// Zustand der Erinnerung. Fällig ab genau LIBRARY_REFRESH_INTERVAL_DAYS * 24 h (>=).
// Ohne Libraries, ohne gültigen Zeitpunkt oder mit einem Zeitpunkt in der Zukunft (Uhr war vorgestellt und wurde korrigiert)
// ist der Zeitpunkt unbekannt/unsicher: importedAt ist dann null und es ist nichts fällig (loadLibraryRefresh setzt eine
// neue Baseline). Ein fehlendes origin gilt konservativ als Baseline, nie als echter Refresh.
export function libraryRefreshState({ importedAt, origin, now, hasLibraries }) {
  if (!hasLibraries || !isTimestamp(importedAt) || importedAt > now) {
    return { importedAt: null, origin: null, ageDays: null, due: false }
  }

  const age = now - importedAt

  return {
    importedAt,
    origin: origin === REFRESH_ORIGIN.IMPORT ? REFRESH_ORIGIN.IMPORT : REFRESH_ORIGIN.BASELINE,
    ageDays: Math.floor(age / DAY_MS),
    due: age >= LIBRARY_REFRESH_INTERVAL_MS,
  }
}

// Der Import hat mindestens eine Library übernommen oder als bereits aktuell bestätigt (Anlass für die Speicheranfrage).
export function isSuccessfulLibraryImport(results) {
  return results.some((result) => result.libraryId && LIBRARY_OK_STATUSES.includes(result.status))
}

// Vollständiger, sauberer Refresh = die Vorgangsergebnisse (Batch bzw. Batch nach bestätigten Updates) belegen den GANZEN
// aktuell gespeicherten Bestand:
//   1. jedes Ergebnis ist ein Erfolg (new / known / versionUpdated / Ersetzungsliste) – keine ungültige, übersprungene oder
//      abgelehnte Datei, kein blockiertes oder noch unbestätigtes Update;
//   2. jede gespeicherte libraryId kommt mit einem Erfolgsstatus vor.
// Teilimporte (1/24, 23/24), Einzelupdates und Batches mit Fehlern erneuern den globalen Zeitpunkt deshalb nicht.
export function isCompleteCleanRefresh(results, storedLibraryIds) {
  if (results.length === 0 || storedLibraryIds.length === 0) {
    return false
  }

  if (!results.every((result) => resultSeverity(result.status) === 'info')) {
    return false
  }

  const covered = new Set(
    results.filter((result) => result.libraryId && LIBRARY_OK_STATUSES.includes(result.status)).map((result) => result.libraryId),
  )

  return storedLibraryIds.every((libraryId) => covered.has(libraryId))
}

// Lädt den Zustand beim Start. Stehen Libraries ohne gültigen Zeitpunkt da (Altbestand, beschädigt, Zukunftswert), wird einmalig
// jetzt als Baseline gespeichert: kein sofortiger Hinweis, die Erinnerung beginnt ab jetzt. Die Baseline gilt nicht als
// Aktualisierungsdatum (origin 'baseline'), bis ein vollständiger Refresh sie ersetzt.
export async function loadLibraryRefresh(store, { now = Date.now() } = {}) {
  const hasLibraries = (await store.listLibraryStates()).length > 0
  const record = await store.getLibraryImportRecord()
  const state = libraryRefreshState({ importedAt: record?.value, origin: record?.origin, now, hasLibraries })

  if (hasLibraries && state.importedAt === null) {
    await store.recordLibraryImport(now, REFRESH_ORIGIN.BASELINE)

    return libraryRefreshState({ importedAt: now, origin: REFRESH_ORIGIN.BASELINE, now, hasLibraries })
  }

  return state
}

// Merkt einen vollständigen, sauberen Refresh (best effort: ein Fehler beim Merken darf den Import nicht beeinträchtigen).
export async function noteLibraryImport(store, results, { now = Date.now() } = {}) {
  try {
    const storedLibraryIds = (await store.listLibraryStates()).map((state) => state.libraryId)

    if (!isCompleteCleanRefresh(results, storedLibraryIds)) {
      return false
    }

    await store.recordLibraryImport(now, REFRESH_ORIGIN.IMPORT)

    return true
  } catch {
    return false
  }
}

// Datum für die Anzeige, z. B. "09.11.2026" (de) bzw. "Nov 9, 2026" (en).
export function formatImportDate(timestamp, language) {
  return language === 'en'
    ? new Date(timestamp).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
    : new Date(timestamp).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

// Bittet den Browser, die lokalen Daten nicht automatisch zu bereinigen. Nur Best-Effort ohne eigene Oberfläche;
// die App hängt nicht davon ab (fehlende Unterstützung oder Ablehnung bleiben folgenlos).
export async function requestPersistentStorage(storage = globalThis.navigator?.storage) {
  try {
    if (!storage || typeof storage.persist !== 'function') {
      return null
    }

    if (typeof storage.persisted === 'function' && (await storage.persisted())) {
      return true
    }

    return Boolean(await storage.persist())
  } catch {
    return null
  }
}
