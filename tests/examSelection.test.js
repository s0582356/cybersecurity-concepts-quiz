import { describe, expect, it } from 'vitest'
import {
  EXAM_DEFAULT_PRESET,
  EXAM_ERROR,
  EXAM_MIN_QUESTIONS,
  EXAM_PRESETS,
  ExamError,
  allocateSectionQuotas,
  resolveExamCount,
  selectExamQuestions,
} from '../src/domain/examSelection.js'
import { seededRandom } from './fixtures/examFixtures.js'

// Abschnittsgrößen des finalen Contents laut Phase-3A-Spec (Pool 1179).
const SPEC_SIZES = { la01: 173, la02: 239, la03: 104, la04: 124, la05: 89, la06: 85, la07: 184, la08: 77, la09: 104 }
const SPEC_QUOTAS = {
  20: [3, 4, 2, 2, 2, 1, 3, 1, 2],
  45: [7, 9, 4, 5, 3, 3, 7, 3, 4],
  90: [13, 18, 8, 9, 7, 7, 14, 6, 8],
}
const sizeList = (sizes) => Object.entries(sizes).map(([sectionId, size]) => ({ sectionId, size }))

function makePool(sizes) {
  return Object.entries(sizes).flatMap(([sectionId, size]) =>
    Array.from({ length: size }, (_, index) => ({ id: `${sectionId}-q${String(index).padStart(3, '0')}`, sectionId })),
  )
}

const countBySection = (entries) => entries.reduce((counts, entry) => ({ ...counts, [entry.sectionId]: (counts[entry.sectionId] ?? 0) + 1 }), {})

describe('exam presets', () => {
  it('offers 20 / 45 / 90 with 45 as default', () => {
    expect(EXAM_PRESETS).toEqual({ short: 20, medium: 45, long: 90 })
    expect(EXAM_DEFAULT_PRESET).toBe('medium')
    expect(resolveExamCount()).toEqual({ count: 45, preset: 'medium' })
    expect(resolveExamCount({ preset: 'short' })).toEqual({ count: 20, preset: 'short' })
    expect(resolveExamCount({ preset: 'long' })).toEqual({ count: 90, preset: 'long' })
    expect(EXAM_MIN_QUESTIONS).toBe(10)
  })

  it('accepts an explicit valid count and rejects invalid input', () => {
    expect(resolveExamCount({ count: 12 })).toEqual({ count: 12, preset: 'custom' })

    for (const count of [0, -3, 2.5, '45', NaN]) {
      expect(() => resolveExamCount({ count })).toThrow(expect.objectContaining({ code: EXAM_ERROR.INVALID_COUNT }))
    }

    expect(() => resolveExamCount({ preset: 'marathon' })).toThrow(expect.objectContaining({ code: EXAM_ERROR.INVALID_PRESET }))
    expect(() => resolveExamCount({ preset: 'toString' })).toThrow(ExamError)
  })
})

describe('section quotas (largest remainder)', () => {
  it.each([20, 45, 90])('reproduces the Phase-3A table for N=%i with sum exactly N', (count) => {
    const quotas = allocateSectionQuotas(sizeList(SPEC_SIZES), count)

    expect(Object.keys(SPEC_SIZES).map((sectionId) => quotas.get(sectionId))).toEqual(SPEC_QUOTAS[count])
    expect([...quotas.values()].reduce((sum, quota) => sum + quota, 0)).toBe(count)
  })

  it('always sums to N and never exceeds a section size, also for awkward pools', () => {
    const random = seededRandom(7)

    for (let run = 0; run < 200; run++) {
      const sections = Array.from({ length: 1 + Math.floor(random() * 9) }, (_, index) => ({
        sectionId: `la${String(index + 1).padStart(2, '0')}`,
        size: 1 + Math.floor(random() * 40),
      }))
      const total = sections.reduce((sum, section) => sum + section.size, 0)
      const count = 1 + Math.floor(random() * total)
      const quotas = allocateSectionQuotas(sections, count)

      expect([...quotas.values()].reduce((sum, quota) => sum + quota, 0)).toBe(count)
      sections.forEach((section) => expect(quotas.get(section.sectionId)).toBeLessThanOrEqual(section.size))
    }
  })

  it('breaks remainder ties by ascending section id and does not depend on input order', () => {
    // 3 gleich große Abschnitte, N=2: je Rest gleich -> la01 und la02 bekommen den Platz.
    const forward = allocateSectionQuotas([{ sectionId: 'la01', size: 10 }, { sectionId: 'la02', size: 10 }, { sectionId: 'la03', size: 10 }], 2)
    const reversed = allocateSectionQuotas([{ sectionId: 'la03', size: 10 }, { sectionId: 'la02', size: 10 }, { sectionId: 'la01', size: 10 }], 2)

    expect([...forward.entries()]).toEqual([['la01', 1], ['la02', 1], ['la03', 0]])
    expect([...reversed.entries()]).toEqual([...forward.entries()])
  })

  it('can take every question (N equals the pool)', () => {
    const quotas = allocateSectionQuotas(sizeList({ la01: 3, la02: 5 }), 8)

    expect([...quotas.entries()]).toEqual([['la01', 3], ['la02', 5]])
  })

  it('fails cleanly for a pool that is too small or an invalid count', () => {
    expect(() => allocateSectionQuotas(sizeList({ la01: 3 }), 4)).toThrow(expect.objectContaining({ code: EXAM_ERROR.POOL_TOO_SMALL }))
    expect(() => allocateSectionQuotas(sizeList({ la01: 3 }), 0)).toThrow(expect.objectContaining({ code: EXAM_ERROR.INVALID_COUNT }))
  })
})

describe('selectExamQuestions', () => {
  const pool = makePool(SPEC_SIZES)

  it.each([20, 45, 90])('selects exactly %i unique questions, stratified by section', (count) => {
    const selected = selectExamQuestions(pool, count, seededRandom(count))

    expect(selected).toHaveLength(count)
    expect(new Set(selected.map((entry) => entry.id)).size).toBe(count)
    expect(selected.every((entry) => pool.includes(entry))).toBe(true)

    const quotas = SPEC_QUOTAS[count]
    Object.keys(SPEC_SIZES).forEach((sectionId, index) => expect(countBySection(selected)[sectionId]).toBe(quotas[index]))
  })

  it('does not ignore a section when the count allows it (N=45 reaches all 9 sections)', () => {
    const selected = selectExamQuestions(pool, 45, seededRandom(3))

    expect(Object.keys(countBySection(selected))).toHaveLength(9)
  })

  it('is deterministic for a given RNG and differs for another one', () => {
    const first = selectExamQuestions(pool, 45, seededRandom(11)).map((entry) => entry.id)
    const second = selectExamQuestions(pool, 45, seededRandom(11)).map((entry) => entry.id)
    const other = selectExamQuestions(pool, 45, seededRandom(12)).map((entry) => entry.id)

    expect(second).toEqual(first)
    expect(other).not.toEqual(first)
  })

  it('mixes the sections in the final order (not grouped by section)', () => {
    const sections = selectExamQuestions(pool, 45, seededRandom(5)).map((entry) => entry.sectionId)
    const changes = sections.filter((section, index) => index > 0 && section !== sections[index - 1]).length

    expect(changes).toBeGreaterThan(9)
  })

  it('does not mutate the pool', () => {
    const copy = pool.map((entry) => ({ ...entry }))

    selectExamQuestions(pool, 90, seededRandom(1))
    expect(pool).toEqual(copy)
  })

  it('rejects a pool that is too small, an invalid count and duplicate pool ids', () => {
    expect(() => selectExamQuestions(makePool({ la01: 5 }), 20)).toThrow(expect.objectContaining({ code: EXAM_ERROR.POOL_TOO_SMALL }))
    expect(() => selectExamQuestions(pool, 0)).toThrow(expect.objectContaining({ code: EXAM_ERROR.INVALID_COUNT }))
    expect(() => selectExamQuestions([...pool.slice(0, 30), pool[0]], 10)).toThrow(
      expect.objectContaining({ code: EXAM_ERROR.DUPLICATE_POOL_IDS }),
    )
  })

  it('handles a single-section pool', () => {
    const selected = selectExamQuestions(makePool({ la01: 30 }), 20, seededRandom(2))

    expect(new Set(selected.map((entry) => entry.id)).size).toBe(20)
  })
})
