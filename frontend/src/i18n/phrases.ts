// Phrases several views share, so the catalog has them once (plan E1.9).
import { t } from '@lingui/core/macro'
import { formatNumber } from './locale'

/** The ⋯ menu of a row or layer. */
export const actionsFor = (name: string) => t`Aktionen für ${name}`

/** Title of a confirmation to delete something named. */
export const deleteTitle = (name: string) => t`„${name}" löschen?`

/** "120 von 1'200": hits of all objects of the result layer (design B1). */
export function hitsOf(hits: number, total: number) {
  const shown = formatNumber(hits)
  const all = formatNumber(total)
  return t`${shown} von ${all}`
}
