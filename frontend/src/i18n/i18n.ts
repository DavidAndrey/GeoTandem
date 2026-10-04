// The active language (plan E1.9). German is the source and the only real
// language; "pseudo" is chosen with ?lang=pseudo and kept for the tab (L7).
import { i18n } from '@lingui/core'
import { messages as de } from '../locales/de.po'

export type Locale = 'de' | 'pseudo'

const STORAGE_KEY = 'geotandem.lang'

export function activate(locale: Locale, messages = de) {
  i18n.loadAndActivate({ locale, messages })
  // Pseudo text is no language a screen reader knows; German is closest.
  document.documentElement.lang = 'de'
}

/** "?lang=pseudo" switches for this tab, "?lang=de" back; anything else keeps it. */
function chosen(search: string): Locale {
  const asked = new URLSearchParams(search).get('lang')
  try {
    if (asked === 'pseudo' || asked === 'de') sessionStorage.setItem(STORAGE_KEY, asked)
    return sessionStorage.getItem(STORAGE_KEY) === 'pseudo' ? 'pseudo' : 'de'
  } catch {
    return asked === 'pseudo' ? 'pseudo' : 'de'
  }
}

export async function setupI18n(search: string) {
  if (chosen(search) === 'pseudo') {
    // Loaded only when asked for: the pseudo catalog is a chunk of its own.
    const { messages } = await import('../locales/pseudo.po')
    activate('pseudo', messages)
  } else activate('de')
}
