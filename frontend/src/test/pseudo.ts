// Pseudo-locale checks (plan E1.9, L7, L8): text that went through the
// catalog is bracketed ⟦…⟧; anything else in a builder's output is either
// data the test names or a fragment joined outside a message.
import { activate } from '../i18n/i18n'
import { messages } from '../locales/pseudo.po'

export function inPseudo<T>(run: () => T): T {
  activate('pseudo', messages)
  try {
    return run()
  } finally {
    activate('de')
  }
}

/** The letters of ``text`` outside every ⟦…⟧ and outside the given ``data``. */
export function unmarked(text: string, data: string[] = []): string {
  let rest = text
  for (const value of [...data].sort((a, b) => b.length - a.length))
    rest = rest.split(value).join('')
  for (let previous = ''; previous !== rest;) {
    previous = rest
    rest = rest.replace(/⟦[^⟦⟧]*⟧/g, '')
  }
  return rest.replace(/[^\p{L}]/gu, '')
}
