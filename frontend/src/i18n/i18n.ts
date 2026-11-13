// The active language (plan E1.9). German is the source, French the first
// translation; "pseudo" is chosen with ?lang=pseudo and kept for the tab (L7).
import { i18n } from '@lingui/core'
import { messages as de } from '../locales/de.po'

export type Locale = 'de' | 'fr' | 'pseudo'

/** The languages a user can choose, each written in its own language. */
export const LANGUAGES: { locale: Exclude<Locale, 'pseudo'>; name: string }[] = [
  { locale: 'de', name: 'Deutsch' },
  { locale: 'fr', name: 'Français' },
]

const STORAGE_KEY = 'geotandem.lang'

export function activate(locale: Locale, messages = de) {
  i18n.loadAndActivate({ locale, messages })
  // Pseudo text is no language a screen reader knows; German is closest.
  document.documentElement.lang = locale === 'pseudo' ? 'de' : locale
}

const isLocale = (value: unknown): value is Locale =>
  value === 'de' || value === 'fr' || value === 'pseudo'

function read(storage: () => Storage): string | null {
  try {
    return storage().getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function write(storage: () => Storage, locale: Locale) {
  try {
    storage().setItem(STORAGE_KEY, locale)
  } catch {
    // Without storage the choice holds for this page view only.
  }
}

/**
 * "?lang=fr" switches (kept in the browser, "pseudo" only for this tab),
 * "?lang=de" back; without it the kept choice, else the browser's language.
 */
function chosen(search: string, browser: string): Locale {
  const asked = new URLSearchParams(search).get('lang')
  if (isLocale(asked)) {
    write(asked === 'pseudo' ? () => sessionStorage : () => localStorage, asked)
    return asked
  }
  if (read(() => sessionStorage) === 'pseudo') return 'pseudo'
  const kept = read(() => localStorage)
  if (isLocale(kept) && kept !== 'pseudo') return kept
  return browser.toLowerCase().startsWith('fr') ? 'fr' : 'de'
}

async function load(locale: Locale) {
  // Loaded only when needed: each other catalog is a chunk of its own.
  if (locale === 'fr') return activate('fr', (await import('../locales/fr.po')).messages)
  if (locale === 'pseudo') return activate('pseudo', (await import('../locales/pseudo.po')).messages)
  activate('de')
}

export const setupI18n = (search: string, browser = navigator.language) =>
  load(chosen(search, browser))

/** The language the user picks in the menu: kept for later visits. */
export async function chooseLanguage(locale: Exclude<Locale, 'pseudo'>) {
  try {
    sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    // see write()
  }
  write(() => localStorage, locale)
  await load(locale)
}
