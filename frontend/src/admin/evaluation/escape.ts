// Esc in a field that uses it itself (the new tag of ``TagEditor``) must not
// close the dialog around it. Radix listens for Esc on the document in the
// capture phase, so the field cannot stop it; the dialog asks here instead.

/** Marks a field whose Esc is its own. */
export const OWN_ESCAPE = { 'data-own-escape': '' } as const

/** For ``Modal``'s ``onEscapeKeyDown``: keeps the dialog open while Esc belongs to a field. */
export function keepEscapeInField(event: KeyboardEvent) {
  if (event.target instanceof Element && event.target.closest('[data-own-escape]'))
    event.preventDefault()
}
