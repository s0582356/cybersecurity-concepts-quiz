// Hilfen für die Exam-Core-Tests (Phase 3B). Nur synthetische Fragen.

import { registerLibraryImport } from '../../src/storage/libraryImport.js'
import { parseV2Library } from '../../src/lib/library/parseLibrary.js'
import { makeSyntheticLibrary } from './syntheticLibrary.js'

// Deterministisches RNG (mulberry32) für reproduzierbare Auswahl/Mischung.
export function seededRandom(seed = 1) {
  let state = seed >>> 0

  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    Object.values(value).forEach(deepFreeze)
  }

  return value
}

export const clone = (value) => JSON.parse(JSON.stringify(value))

// Eine Library je Lernabschnitt: { la01: 12, la02: 20 } -> libraryId exam-lib-la01, IDs sec-a01-0001…
// `overrides[sectionId]` ersetzt Optionen von makeSyntheticLibrary (Update-Szenarien: Version, Hash, Revisionen …).
export function makeExamLibraryData(sizes = { la01: 12, la02: 20, la03: 8 }, { english = 'all', overrides = {} } = {}) {
  return Object.entries(sizes).map(([sectionId, count], index) => {
    const number = sectionId.slice(2)

    return makeSyntheticLibrary({
      libraryId: `exam-lib-${sectionId}`,
      activeQuestionIndexHash: `sha256:${(index + 1).toString(16).repeat(64)}`,
      idPrefix: `sec-a${number}`,
      learningSectionId: sectionId,
      count,
      english,
      questionLabel: `Frage ${sectionId}`,
      ...overrides[sectionId],
    })
  })
}

export async function importExamLibraries(store, dataList, now = 1000) {
  for (const data of dataList) {
    const { library, questions } = parseV2Library(data)

    await registerLibraryImport(store, library, { now, questions })
  }
}
