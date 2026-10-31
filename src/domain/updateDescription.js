// Verständliche Meldungen zu Import- und Update-Ergebnissen (Phase 2C/2D/2E), als übersetzbare Deskriptoren.

import { msg } from '../i18n/index.js'
import { CHANGE_KIND } from './libraryUpdate.js'

const INTRO = msg('update.intro')

export function describeUpdate({ changeKind, change, replacements, unexplained }) {
  const count = (list) => list?.length ?? 0

  if (changeKind === CHANGE_KIND.QUESTIONS_REPLACED) {
    const inherited = replacements.filter((replacement) => replacement.policy === 'inherit').length

    return {
      compatible: true,
      message: msg('update.replaced', {
        intro: INTRO,
        count: replacements.length,
        inherited,
        reset: replacements.length - inherited,
      }),
    }
  }

  if (changeKind === CHANGE_KIND.QUESTIONS_REMOVED) {
    return {
      compatible: false,
      message: msg('update.removed', { intro: INTRO, count: count(change.removed), unexplained: count(unexplained) }),
    }
  }

  if (changeKind === CHANGE_KIND.REVISIONS_ONLY) {
    return { compatible: true, message: msg('update.revisions', { intro: INTRO, count: count(change.revised) }) }
  }

  if (changeKind === CHANGE_KIND.QUESTIONS_ADDED) {
    return {
      compatible: true,
      message: msg('update.added', {
        intro: INTRO,
        count: count(change.added),
        revised: count(change.revised) > 0 ? msg('update.addedRevised', { count: count(change.revised) }) : '',
      }),
    }
  }

  return { compatible: false, message: msg('update.other', { intro: INTRO }) }
}
