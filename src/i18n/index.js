// Kleine zentrale Übersetzungsschicht (Phase 2F), bewusst ohne Framework.
//
// Zwei getrennte Zustände:
// - uiLocale      Sprache der Oberfläche
// - contentLocale gewünschte Sprache der Frageninhalte (ob sie verfügbar ist, entscheidet die Content-Abdeckung)
// Der normale Sprachschalter setzt beide gemeinsam; intern bleiben sie getrennt.
//
// Meldungen aus Domain-/Storage-Code sind Deskriptoren `{ i18n, params }` (siehe `msg`) und werden erst beim
// Anzeigen übersetzt – ein Sprachwechsel übersetzt deshalb auch bereits angezeigte Import-Ergebnisse.
// Die Sprachpräferenz liegt in localStorage (eine kleine, bibliotheksunabhängige Einstellung, siehe DE/EN-Vertrag).

import { ref } from 'vue'
import { de } from './de.js'
import { en } from './en.js'

export const UI_LOCALES = ['de', 'en']
export const DEFAULT_LOCALE = 'de'
export const LANGUAGE_STORAGE_KEY = 'cybersecurity-concepts-quiz.language'

const dictionaries = { de, en }

export const uiLocale = ref(DEFAULT_LOCALE)
export const contentLocale = ref(DEFAULT_LOCALE)
// Fallback-Modus für Englisch (DE/EN-Contract): "Nur Englisch" (Standard) oder "Alle verfügbaren Fragen" (Opt-in).
export const LANGUAGE_MODES = ['onlyEnglish', 'allAvailable']
export const languageMode = ref('onlyEnglish')

export function msg(key, params = {}) {
  return { i18n: key, params }
}

export function isMessage(value) {
  return value !== null && typeof value === 'object' && typeof value.i18n === 'string'
}

function format(template, params) {
  const variants = typeof params.count === 'number' && template.includes('|') ? template.split('|') : null
  const chosen = variants ? (params.count === 1 ? variants[0] : variants[1]) : template

  return chosen.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
}

function translateParam(locale, value) {
  if (isMessage(value)) {
    return translate(locale, value)
  }

  if (Array.isArray(value)) {
    return value.map((item) => (isMessage(item) ? translate(locale, item) : String(item))).join('; ')
  }

  return value
}

// `input`: Schlüssel (String) oder Deskriptor. Unbekannte Schlüssel erscheinen sichtbar als Schlüssel (nie still deutsch).
export function translate(locale, input, extraParams = {}) {
  const key = isMessage(input) ? input.i18n : input
  const rawParams = { ...(isMessage(input) ? input.params : {}), ...extraParams }
  const params = Object.fromEntries(Object.entries(rawParams).map(([name, value]) => [name, translateParam(locale, value)]))
  const template = dictionaries[locale]?.[key]

  return typeof template === 'string' ? format(template, params) : String(key)
}

// Fehler mit übersetzbarer Meldung; `message` ist die deutsche Standardfassung (für Tests/Logs).
export class LocalizedError extends Error {
  constructor(key, params = {}, options = {}) {
    super(translate('de', key, params))
    this.i18n = msg(key, params)
    this.cause = options.cause
  }
}

// Anzeigetext eines beliebigen Fehlers: übersetzbar, wenn möglich; sonst die technische Originalmeldung.
export function describeError(error) {
  return error?.i18n ?? String(error?.message ?? error)
}

export function t(input, params) {
  return translate(uiLocale.value, input, params)
}

function isLocale(value) {
  return UI_LOCALES.includes(value)
}

export function loadLanguagePreference() {
  let stored = null

  try {
    stored = JSON.parse(globalThis.localStorage?.getItem(LANGUAGE_STORAGE_KEY) ?? 'null')
  } catch {
    stored = null
  }

  uiLocale.value = isLocale(stored?.ui) ? stored.ui : DEFAULT_LOCALE
  contentLocale.value = isLocale(stored?.content) ? stored.content : DEFAULT_LOCALE
  languageMode.value = LANGUAGE_MODES.includes(stored?.mode) ? stored.mode : 'onlyEnglish'
}

function savePreference() {
  try {
    globalThis.localStorage?.setItem(
      LANGUAGE_STORAGE_KEY,
      JSON.stringify({ ui: uiLocale.value, content: contentLocale.value, mode: languageMode.value }),
    )
  } catch {
    // Speicher gesperrt: die Sprache gilt dann nur für diese Sitzung.
  }
}

export function setUiLocale(locale) {
  if (isLocale(locale)) {
    uiLocale.value = locale
    savePreference()
  }
}

export function setContentLocale(locale) {
  if (isLocale(locale)) {
    contentLocale.value = locale
    savePreference()
  }
}

export function setLanguageMode(mode) {
  if (LANGUAGE_MODES.includes(mode)) {
    languageMode.value = mode
    savePreference()
  }
}

// Normaler Sprachschalter: Oberfläche und gewünschte Inhaltssprache gemeinsam.
export function setLanguage(locale) {
  if (isLocale(locale)) {
    uiLocale.value = locale
    contentLocale.value = locale
    savePreference()
  }
}

export function messageKeys(locale) {
  return Object.keys(dictionaries[locale])
}
