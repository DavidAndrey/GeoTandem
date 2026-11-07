// A table row that opens its page on a click anywhere in it (Läufe, Prüffälle).
import type { MouseEvent } from 'react'

/** What a click on these leaves to them: the row's own link, a checkbox, a button. */
// eslint-disable-next-line lingui/no-unlocalized-strings -- a CSS selector, not a message
const CONTROLS = 'a, button, input, select, label, textarea'

/**
 * Props for a ``<tr>`` of a ``data-table`` that opens its page on a click. The
 * row's own link stays the way in for keyboard and screen readers; clicks on a
 * control or ending a text selection are left alone.
 */
export function rowOpener(open: () => void) {
  return {
    className: 'row-link',
    onClick: (e: MouseEvent<HTMLTableRowElement>) => {
      if ((e.target as HTMLElement).closest(CONTROLS)) return
      if (window.getSelection()?.toString()) return
      open()
    },
  }
}
