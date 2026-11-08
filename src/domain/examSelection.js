// Fragenauswahl für den Prüfungsmodus (Phase 3B). Rein, keine IO.
//
// Pool-Einträge: { id, sectionId, ... } (ein Eintrag je aktive Frage). Die Auswahl ist
// - proportional nach Lernabschnitt gewichtet (Quote = N · n_s / P, Rest nach "größter Rest"),
// - innerhalb eines Abschnitts zufällig ohne Zurücklegen,
// - danach einmal global gemischt.
// Der Zufall kommt ausschließlich über das injizierte `random` (Standard Math.random); Tests übergeben ein
// deterministisches RNG. Die gewürfelte Reihenfolge wird im Versuch gespeichert, nie neu berechnet.

import { shuffled } from './session.js'

// Presets sind Trainingsentscheidungen dieses Projekts, keine CompTIA-Vorgaben.
export const EXAM_PRESETS = { short: 20, medium: 45, long: 90 }
export const EXAM_DEFAULT_PRESET = 'medium'
// Kleinster Pool, ab dem eine Prüfung gestartet werden kann.
export const EXAM_MIN_QUESTIONS = 10

export class ExamError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'ExamError'
    this.code = code
  }
}

export const EXAM_ERROR = {
  INVALID_COUNT: 'invalidCount',
  INVALID_PRESET: 'invalidPreset',
  INVALID_LANGUAGE: 'invalidLanguage',
  POOL_TOO_SMALL: 'poolTooSmall',
  DUPLICATE_POOL_IDS: 'duplicatePoolIds',
  CONTENT_UNAVAILABLE: 'contentUnavailable',
  INVALID_ATTEMPT: 'invalidAttempt',
}

// Preset-Name oder explizite Zahl -> Fragenanzahl. Keine Begrenzung auf den Pool (das ist Sache von `selectExamQuestions`).
export function resolveExamCount({ preset = null, count = null } = {}) {
  if (count !== null && count !== undefined) {
    if (!Number.isInteger(count) || count < 1) {
      throw new ExamError(EXAM_ERROR.INVALID_COUNT, String(count))
    }

    return { count, preset: 'custom' }
  }

  const name = preset ?? EXAM_DEFAULT_PRESET

  if (!Object.hasOwn(EXAM_PRESETS, name)) {
    throw new ExamError(EXAM_ERROR.INVALID_PRESET, String(name))
  }

  return { count: EXAM_PRESETS[name], preset: name }
}

const bySectionId = (left, right) => left.localeCompare(right, 'en', { numeric: true })

// Quoten je Abschnitt: Summe exakt `count`, jede Quote ≤ Abschnittsgröße.
// Rundung: abrunden, die fehlenden Plätze gehen nach größtem Rest (Gleichstand: Abschnitts-ID aufsteigend).
export function allocateSectionQuotas(sectionSizes, count) {
  const total = sectionSizes.reduce((sum, section) => sum + section.size, 0)

  if (!Number.isInteger(count) || count < 1) {
    throw new ExamError(EXAM_ERROR.INVALID_COUNT, String(count))
  }

  if (count > total) {
    throw new ExamError(EXAM_ERROR.POOL_TOO_SMALL, `${count} > ${total}`)
  }

  // Ganzzahlig gerechnet (count·size = base·total + rest): keine Gleitkomma-Rundungsfehler.
  const rows = sectionSizes
    .map(({ sectionId, size }) => ({
      sectionId,
      size,
      quota: Math.floor((count * size) / total),
      remainder: (count * size) % total,
    }))
    .sort((left, right) => bySectionId(left.sectionId, right.sectionId))
  let missing = count - rows.reduce((sum, row) => sum + row.quota, 0)

  ;[...rows]
    .sort((left, right) => right.remainder - left.remainder || bySectionId(left.sectionId, right.sectionId))
    .forEach((row) => {
      if (missing > 0 && row.quota < row.size) {
        row.quota++
        missing--
      }
    })

  return new Map(rows.map((row) => [row.sectionId, row.quota]))
}

// Wählt exakt `count` Pool-Einträge (eindeutige IDs) und liefert sie in der endgültigen Prüfungsreihenfolge.
export function selectExamQuestions(pool, count, random = Math.random) {
  const ids = new Set(pool.map((entry) => entry.id))

  if (ids.size !== pool.length) {
    throw new ExamError(EXAM_ERROR.DUPLICATE_POOL_IDS)
  }

  const sections = new Map()

  pool.forEach((entry) => {
    if (!sections.has(entry.sectionId)) {
      sections.set(entry.sectionId, [])
    }

    sections.get(entry.sectionId).push(entry)
  })

  const quotas = allocateSectionQuotas(
    [...sections.entries()].map(([sectionId, entries]) => ({ sectionId, size: entries.length })),
    count,
  )
  // Abschnitte in fester Reihenfolge verarbeiten, damit ein gegebenes RNG immer dasselbe Ergebnis liefert.
  const picked = [...sections.keys()]
    .sort(bySectionId)
    .flatMap((sectionId) => shuffled(sections.get(sectionId), random).slice(0, quotas.get(sectionId)))
  const result = shuffled(picked, random)

  if (result.length !== count || new Set(result.map((entry) => entry.id)).size !== count || result.some((entry) => !ids.has(entry.id))) {
    throw new ExamError(EXAM_ERROR.INVALID_COUNT, 'Auswahl verletzt die Nachbedingungen.')
  }

  return result
}
