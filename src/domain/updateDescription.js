// Verständliche Texte zu Import- und Update-Ergebnissen (Phase 2C/2D/2E).

import { CHANGE_KIND } from './libraryUpdate.js'

export const UPDATE_INTRO =
  'Diese Bibliothek wurde aktualisiert. Dein bisheriger Lernfortschritt bleibt gespeichert, ' +
  'aber die aktuelle Lernrunde kann erst nach einer Fortschrittsmigration fortgesetzt werden.'

export function describeUpdate({ changeKind, change, replacements, unexplained }) {
  const count = (list) => list?.length ?? 0

  if (changeKind === CHANGE_KIND.QUESTIONS_REPLACED) {
    const inherited = replacements.filter((replacement) => replacement.policy === 'inherit').length
    const reset = replacements.length - inherited

    return {
      compatible: true,
      text:
        `${UPDATE_INTRO} ${replacements.length} Fragen wurden ersetzt: ${inherited} übernehmen den bisherigen Fortschritt ` +
        `(gleiches Lernziel), ${reset} starten ohne Fortschritt (neues Lernziel). ` +
        'Eine laufende Lernrunde wird nur angepasst, wenn das sicher möglich ist. ' +
        'Du kannst die Aktualisierung bewusst übernehmen. Die Datei wurde noch nicht geladen.',
    }
  }

  if (changeKind === CHANGE_KIND.QUESTIONS_REMOVED) {
    return {
      compatible: false,
      text:
        `${UPDATE_INTRO} ${count(change.removed)} Fragen wurden entfernt, ${count(unexplained)} davon sind durch ` +
        'den Ersetzungs-Index nicht erklärt (Index fehlt oder die Ziel-Bibliothek ist nicht geladen). ' +
        'Lade die Ersetzungsliste (retired-index.json) bzw. die Ziel-Bibliothek und importiere die Datei erneut. ' +
        'Die Datei wurde nicht geladen; Fortschritt und Lernrunde bleiben unverändert gespeichert.',
    }
  }

  if (changeKind === CHANGE_KIND.REVISIONS_ONLY) {
    return {
      compatible: true,
      text:
        `${UPDATE_INTRO} ${count(change.revised)} Fragen wurden überarbeitet; dein Fortschritt dazu bleibt erhalten. ` +
        'Du kannst die Aktualisierung bewusst übernehmen. Die Datei wurde noch nicht geladen.',
    }
  }

  if (changeKind === CHANGE_KIND.QUESTIONS_ADDED) {
    return {
      compatible: true,
      text:
        `${UPDATE_INTRO} ${count(change.added)} Fragen sind neu (sie starten ohne Fortschritt)` +
        (count(change.revised) > 0 ? `, ${count(change.revised)} wurden überarbeitet` : '') +
        '. Eine laufende Lernrunde kann danach nicht fortgesetzt, nur neu gestartet werden. ' +
        'Die Datei wurde noch nicht geladen.',
    }
  }

  return {
    compatible: false,
    text:
      `${UPDATE_INTRO} Diese Änderung kann in dieser App-Version noch nicht übernommen werden ` +
      '(z. B. entfernte Fragen oder eine abweichende Datei). Die Datei wurde nicht geladen; ' +
      'Fortschritt und Lernrunde bleiben unverändert gespeichert.',
  }
}
