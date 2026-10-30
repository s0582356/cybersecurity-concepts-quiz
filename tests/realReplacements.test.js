// Optional, nur lokal: prüft die echten Replacement-Paare gegen die private Security-V2-Quelle.
//   SECURITY_REPO_PATH=/pfad/zu/security-plus npm test
// Es werden keine privaten Inhalte in dieses Repo kopiert oder ausgegeben.
import 'fake-indexeddb/auto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createProgressStore } from '../src/storage/progressStore.js'
import { applyLibraryUpdate, registerLibraryImport } from '../src/storage/libraryImport.js'
import { parseRetiredIndex } from '../src/domain/replacementMigration.js'
import { CHANGE_KIND } from '../src/domain/libraryUpdate.js'
import { parseV2Library } from '../src/lib/library/parseLibrary.js'

const root = process.env.SECURITY_REPO_PATH
function load(path) {
  return parseV2Library(JSON.parse(readFileSync(path, 'utf8')))
}

describe.skipIf(!root || !existsSync(root))('real replacement pairs (local security repo)', () => {
  let store
  let finals
  let index

  beforeEach(async () => {
    store = createProgressStore({ dbName: `real-${Math.random().toString(36).slice(2)}` })
    await store.initialize()
    const dir = join(root, 'audit/final')

    finals = readdirSync(dir)
      .filter((name) => /^security-plus-v2-la.*\.json$/.test(name))
      .map((name) => load(join(dir, name)))
    index = parseRetiredIndex(JSON.parse(readFileSync(join(root, 'id-registry/retired-index.json'), 'utf8')))
  })

  afterEach(() => store.close())

  // Die Paare werden zur Laufzeit aus der lokalen Registry gelesen; sie stehen nicht in diesem Repo.
  it('the registry is valid: five confirmed inherit entries and two reset entries', () => {
    const entries = Object.values(index)

    expect(entries).toHaveLength(7)
    expect(entries.filter((entry) => entry.progressMigration === 'inherit')).toHaveLength(5)
    expect(entries.filter((entry) => entry.progressMigration === 'inherit').every((entry) => entry.learningGoalEquivalence === 'confirmed')).toBe(true)
    expect(entries.filter((entry) => entry.progressMigration === 'reset')).toHaveLength(2)
  })

  it('no retired ID is active in a final library and every target is active in exactly one', () => {
    Object.entries(index).forEach(([from, entry]) => {
      expect(finals.filter((item) => from in item.library.questionRevisions)).toHaveLength(0)
      expect(finals.filter((item) => entry.replacedBy in item.library.questionRevisions)).toHaveLength(1)
    })
  })

  // Vorstufen der Libraries (mit den retired Fragen) → aktueller Stand mit echtem Index.
  function preLibraries() {
    const dir = join(root, 'audit/legacy_normalization_work/dedup_pre_libs')

    return readdirSync(dir)
      .filter((name) => /^security-plus-v2-la.*\.json$/.test(name))
      .map((name) => load(join(dir, name)))
      .map((pre) => ({ pre, retired: Object.keys(index).filter((id) => id in pre.library.questionRevisions) }))
      .filter((item) => item.retired.length > 0)
  }

  it('the historical libraries cover all inherit entries', () => {
    const covered = preLibraries().flatMap((item) => item.retired)

    expect(covered.filter((id) => index[id].progressMigration === 'inherit')).toHaveLength(5)
  })

  it('every historical library: the removal is fully explained and inherit moves portable progress to the keep question', async () => {
    for (const { pre, retired } of preLibraries()) {
      const name = pre.library.libraryId
      const current = finals.find((item) => item.library.libraryId === name)

      for (const item of finals) {
        if (item.library.libraryId !== name) {
          await registerLibraryImport(store, item.library, { now: 1 })
        }
      }

      await registerLibraryImport(store, pre.library, { now: 1 })

      for (const id of retired) {
        await store.recordAnswer({ libraryId: name, questionId: id, isCorrect: false, answeredAt: 10 })
      }

      const result = await registerLibraryImport(store, current.library, { retiredIndex: index })

      expect(result.changeKind).toBe(CHANGE_KIND.QUESTIONS_REPLACED)
      expect(result.compatible).toBe(true)
      expect(result.replacements.map((item) => item.from).sort()).toEqual([...retired].sort())

      await applyLibraryUpdate(store, current.library, { retiredIndex: index })

      for (const id of retired) {
        const to = index[id].replacedBy
        const targetLibrary = finals.find((item) => to in item.library.questionRevisions).library.libraryId

        expect(await store.getQuestionProgress(targetLibrary, to)).toMatchObject({ attempts: 1, incorrectCount: 1, lastResult: 'incorrect' })
        expect(await store.getQuestionProgress(name, id)).toMatchObject({ historical: true })
      }

      store.close()
      store = createProgressStore({ dbName: `real-${Math.random().toString(36).slice(2)}` })
      await store.initialize()
    }
  })

  it('reset entries transfer nothing (same-library targets, built from the final library plus the retired ID)', async () => {
    const resets = Object.entries(index).filter(([, entry]) => entry.progressMigration === 'reset')

    expect(resets).toHaveLength(2)

    for (const [from, entry] of resets) {
      const to = entry.replacedBy
      const current = finals.find((item) => to in item.library.questionRevisions).library
      // Historischer Stand: aktuelle Library plus die retired ID (niedrigere Version, anderer Hash)
      const earlier = {
        ...current,
        libraryVersion: '0.9.0',
        activeQuestionIndexHash: `sha256:${'9'.repeat(64)}`,
        questionRevisions: { ...current.questionRevisions, [from]: 1 },
      }
      delete earlier.questionRevisions[to]

      await registerLibraryImport(store, earlier, { now: 1 })
      await store.recordAnswer({ libraryId: current.libraryId, questionId: from, isCorrect: true, answeredAt: 10 })
      await applyLibraryUpdate(store, current, { retiredIndex: index })

      expect(await store.getQuestionProgress(current.libraryId, to)).toBeNull()
      expect(await store.getQuestionProgress(current.libraryId, from)).toMatchObject({ historical: true, migratedTo: { policy: 'reset' } })
    }
  })
})
