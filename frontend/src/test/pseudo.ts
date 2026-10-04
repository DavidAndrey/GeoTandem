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
  // Inside a message, text of a nested element (<Trans>… <b>x</b> …</Trans>)
  // is pseudo but unbracketed: words without a plain ASCII letter are pseudo,
  // since German and the data always have some.
  rest = rest
    .split(/[\s\p{P}]+/u)
    .filter((word) => /[A-Za-z]/.test(word))
    .join(' ')
  return rest.replace(/[^\p{L}]/gu, '')
}

// Leaflet draws its own controls (scale bar, credits); they are not ours.
const SKIP = 'script, style, .leaflet-control-container'
// Unit symbols are the same in every language.
const UNIT = /^\s*(m|km|m²|ha|km²|%)\s*$/

/** Every visible text and label of the page outside the catalog and ``data``. */
export function strays(data: string[]): string[] {
  const found = new Set<string>()
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const element = node.parentElement
    if (!element || element.closest(SKIP) || UNIT.test(node.textContent ?? '')) continue
    // React may split one message into several text nodes; judge the element's text.
    const text = element.textContent ?? ''
    if (unmarked(text, data)) found.add(text.trim())
  }
  for (const element of Array.from(
    document.body.querySelectorAll('[aria-label], [title], [placeholder]'),
  )) {
    if (element.closest(SKIP)) continue
    for (const name of ['aria-label', 'title', 'placeholder']) {
      const value = element.getAttribute(name)
      if (value && unmarked(value, data)) found.add(`${name}="${value}"`)
    }
  }
  return [...found]
}
