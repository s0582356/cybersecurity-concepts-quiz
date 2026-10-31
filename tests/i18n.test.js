// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { de } from '../src/i18n/de.js'
import { en } from '../src/i18n/en.js'
import {
  LANGUAGE_STORAGE_KEY,
  contentLocale,
  loadLanguagePreference,
  msg,
  setContentLocale,
  setLanguage,
  setUiLocale,
  t,
  translate,
  uiLocale,
} from '../src/i18n/index.js'
import { LibraryParseError, parseQuestionFile } from '../src/lib/library/parseLibrary.js'

beforeEach(() => {
  window.localStorage.clear()
  loadLanguagePreference()
})

const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()

describe('translation tables', () => {
  it('German and English define exactly the same keys', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(de).sort())
  })

  it('no empty texts and identical placeholders in both languages', () => {
    Object.keys(de).forEach((key) => {
      expect(de[key].trim(), key).not.toBe('')
      expect(en[key].trim(), key).not.toBe('')
      expect(placeholders(en[key]), key).toEqual(placeholders(de[key]))
    })
  })

  it('English texts are really English where the languages differ in the main UI', () => {
    const mainKeys = ['quiz.next', 'quiz.finish', 'section.learn', 'section.continue', 'session.resume', 'import.button']

    mainKeys.forEach((key) => expect(en[key], key).not.toBe(de[key]))
  })
})

describe('translate', () => {
  it('interpolates parameters, plural variants and nested messages', () => {
    expect(translate('de', 'section.libraries', { count: 1 })).toBe('1 Library')
    expect(translate('de', 'section.libraries', { count: 3 })).toBe('3 Libraries')
    expect(translate('en', 'section.libraries', { count: 1 })).toBe('1 library')
    expect(translate('en', msg('section.label', { id: '8' }))).toBe('Learning section 8')
    expect(translate('de', msg('update.revisions', { intro: msg('update.intro'), count: 2 }))).toContain('2 Fragen wurden überarbeitet')
    expect(translate('en', msg('update.revisions', { intro: msg('update.intro'), count: 2 }))).toContain('2 questions were revised')
  })

  it('shows unknown keys visibly instead of silently falling back to German', () => {
    expect(translate('en', 'does.not.exist')).toBe('does.not.exist')
    expect(translate('xx', 'quiz.next')).toBe('quiz.next')
  })

  it('parser errors carry a key: German message for logs, translatable for the UI', () => {
    let error

    try {
      parseQuestionFile({ schemaVersion: '2.0.0', libraryId: 'x' })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(LibraryParseError)
    expect(error.message).toBe('V2-Library: "libraryId" fehlt oder ist ungültig.')
    expect(translate('en', error.i18n)).toBe('V2 library: "libraryId" is missing or invalid.')
  })
})

describe('language preference', () => {
  it('defaults to German for UI and content', () => {
    expect(uiLocale.value).toBe('de')
    expect(contentLocale.value).toBe('de')
    expect(t('quiz.next')).toBe('Nächste Frage')
  })

  it('the common switch sets both, and the choice survives a reload (one localStorage key)', () => {
    setLanguage('en')
    expect(t('quiz.next')).toBe('Next question')
    expect(JSON.parse(window.localStorage.getItem(LANGUAGE_STORAGE_KEY))).toEqual({ ui: 'en', content: 'en', mode: 'onlyEnglish' })

    uiLocale.value = 'de'
    contentLocale.value = 'de'
    loadLanguagePreference()
    expect(uiLocale.value).toBe('en')
    expect(contentLocale.value).toBe('en')
  })

  it('keeps UI language and content language technically separate', () => {
    setUiLocale('en')
    expect([uiLocale.value, contentLocale.value]).toEqual(['en', 'de'])
    setContentLocale('en')
    setUiLocale('de')
    expect([uiLocale.value, contentLocale.value]).toEqual(['de', 'en'])
  })

  it('ignores unknown locales and corrupt stored values', () => {
    setLanguage('fr')
    expect(uiLocale.value).toBe('de')

    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, '{kaputt')
    loadLanguagePreference()
    expect([uiLocale.value, contentLocale.value]).toEqual(['de', 'de'])

    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, JSON.stringify({ ui: 'fr', content: 'en' }))
    loadLanguagePreference()
    expect([uiLocale.value, contentLocale.value]).toEqual(['de', 'en'])
  })
})
