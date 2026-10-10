// "Änderung gegenüber jetzt" (design M5.1, M5.2, M6.1): what a model query
// does to the analysis, one line per change with the signs of the E1 update
// comparison (design D4, ``fieldChanges``): + new, ~ changed, − gone. Pure;
// the words are the editor's (editor/describe.ts), so a condition reads the
// same here as in the sidebar.
import { t } from '@lingui/core/macro'
import type { Analysis, DisplayLayer, Group, Row } from '../../analysis/model'
import { resultLayer } from '../../analysis/query'
import { rows } from '../../analysis/tree'
import type { LayerInfo } from '../../api/client'
import { describe } from '../../editor/describe'
import { labelsFor } from '../../editor/fields'
import { layerTitle } from '../../workplace/layerInfo'

export type Sign = '+' | '~' | '−'

export interface Change {
  sign: Sign
  text: string
}

/** What a model query sets: a catalog layer as the result, and its conditions. */
export interface Target {
  result: string
  tree: Group
}

export const catalogLayer = (layer: string): DisplayLayer => ({
  id: layer,
  source: { kind: 'catalog', layer },
  visible: true,
  opacity: 1,
  symbology: null,
})

/** Two rows that say the same thing about the same part pair as "~ old → new". */
function partOf(row: Row): string {
  switch (row.kind) {
    case 'attribute':
      return `a:${row.attr}`
    case 'spatial':
      return `s:${row.layer}`
    case 'reference':
      return `r:${row.layer}`
  }
}

interface Said {
  part: string
  text: string
}

/** The changes from ``before`` to ``after``; empty when the query is the analysis already. */
export function changeList(
  before: Analysis,
  after: Target,
  catalog: LayerInfo[] | undefined,
): Change[] {
  const changes: Change[] = []
  const shown = resultLayer(before)
  if (before.result !== after.result || !shown) {
    const from = shown ? layerTitle(shown, catalog) : t`keiner`
    const to = layerTitle(catalogLayer(after.result), catalog)
    changes.push({ sign: '~', text: t`Ergebnis-Layer: ${from} → ${to}` })
  }
  // A model query has no "Nur in" (D3): applying it drops the restriction.
  if (before.restriction)
    changes.push({
      sign: '−',
      text: before.restriction.kind === 'view' ? t`nur im Kartenausschnitt` : t`nur in der Fläche`,
    })

  const say = (layer: DisplayLayer | undefined) => {
    const { labels, filterLabels } = labelsFor(layer, catalog)
    return (row: Row): Said => ({ part: partOf(row), text: describe(row, labels, filterLabels) })
  }
  const old = rows(before.tree).map(say(shown ?? undefined))
  const added = rows(after.tree).map(say(catalogLayer(after.result)))
  // The same condition on both sides is no change.
  for (let i = old.length - 1; i >= 0; i--) {
    const same = added.findIndex((a) => a.text === old[i]?.text)
    if (same >= 0) {
      added.splice(same, 1)
      old.splice(i, 1)
    }
  }
  for (const gone of old) {
    const pair = added.findIndex((a) => a.part === gone.part)
    if (pair >= 0) {
      const [now] = added.splice(pair, 1)
      const was = gone.text
      const is = now?.text ?? ''
      changes.push({ sign: '~', text: t`${was} → ${is}` })
    } else changes.push({ sign: '−', text: gone.text })
  }
  for (const now of added) changes.push({ sign: '+', text: now.text })

  const both = rows(before.tree).length > 0 && rows(after.tree).length > 0
  if (both && before.tree.op !== after.tree.op) {
    const op = (group: Group) => (group.op === 'and' ? t`UND` : t`ODER`)
    const from = op(before.tree)
    const to = op(after.tree)
    changes.push({ sign: '~', text: t`Verknüpfung: ${from} → ${to}` })
  }
  return changes
}
