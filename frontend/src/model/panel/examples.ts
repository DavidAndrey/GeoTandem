// Example prompts from the visible layers (design M1.1: "Beispiele aus den
// sichtbaren Layern"). Built from the layers on the map and what the model may
// see of them (``for_model``), so every example is answerable in principle.
// A click puts the text in the field and never sends.
import { t } from '@lingui/core/macro'
import type { DisplayLayer } from '../../analysis/model'
import type { LayerInfo } from '../../api/client'
import { catalogInfo, panelOrder } from '../../workplace/layerInfo'

const POLYGON = /polygon/i

/** Two or three prompts; none without a visible layer. */
export function examplePrompts(layers: DisplayLayer[], catalog: LayerInfo[] | undefined): string[] {
  const visible = panelOrder(layers)
    .filter((l) => l.visible && !l.table)
    .map((l) => catalogInfo(l, catalog))
    .filter((info): info is LayerInfo => !!info && info.kind === 'vector' && info.for_model)
  const [first, ...others] = visible
  if (!first) return []
  // The subject: a point layer reads best ("Welche Schulen …"), else the first.
  const subject = visible.find((l) => !POLYGON.test(l.geometry_type ?? '')) ?? first
  const rest = [first, ...others].filter((l) => l !== subject)
  const a = subject.title
  const prompts: string[] = []
  const area = rest.find((l) => POLYGON.test(l.geometry_type ?? ''))
  const near = rest.find((l) => !POLYGON.test(l.geometry_type ?? ''))
  if (near) {
    const b = near.title
    prompts.push(t`Welche ${a} liegen nahe an ${b}?`)
  }
  if (area) {
    const b = area.title
    prompts.push(t`Welche ${a} liegen in ${b}?`)
  }
  const numeric = subject.attributes.find(
    (f) => f.for_model && (f.data_type === 'integer' || f.data_type === 'real'),
  )
  if (numeric) {
    const field = numeric.label || numeric.name
    prompts.push(t`${a} mit ${field} über …`)
  }
  return prompts.slice(0, 3)
}
