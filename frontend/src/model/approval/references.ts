// What a waiting proposal's spatial conditions refer to (review #4d): the
// objects "in Gemeinden (Gemeindename = Köniz)" or "≤ 200 m um Bahnhof"
// point at, so the preview can draw them beside its dashed hits and the
// claim can be checked by eye. Pure; the words are the editor's.
import { t } from '@lingui/core/macro'
import type { Condition, QueryObject } from '../../analysis/model'
import { attributeCondition } from '../../analysis/query'
import { rows } from '../../analysis/tree'
import type { LayerInfo, ModelActionView } from '../../api/client'
import { describe } from '../../editor/describe'
import { labelsFor } from '../../editor/fields'
import { proposalDraft } from '../panel/draft'
import { catalogLayer } from './changes'

export interface Reference {
  /** Layer and condition: two rows naming the same objects are drawn once. */
  key: string
  layer: string
  /** The condition as the editor reads it ("liegt in Gemeinden (Gemeindename = Köniz)"). */
  text: string
  /** The objects to draw; ``null``: the whole layer, named but not drawn. */
  query: QueryObject | null
  /** More objects than the map loads at once: drawn within the map view only. */
  limited: boolean
}

const mapQuery = (layer: string, where: Condition): QueryObject => ({
  schema_version: '2',
  source: layer,
  where,
  output: 'map',
})

/**
 * The references of ``view``'s query, in the order of its conditions: a
 * spatial row with a filter on its layer and a reference row with its chosen
 * object are drawn; a spatial row without a filter is only named, its layer
 * as a whole says nothing about what the model chose. Negated rows count too:
 * "nicht in Köniz" refers to Köniz as well.
 */
export function referencesOf(
  view: ModelActionView,
  catalog: LayerInfo[] | undefined,
  maxFeatures: number | undefined,
): Reference[] {
  const draft = proposalDraft(view.query, view.id, catalog)
  if (!draft) return []
  const { labels, filterLabels } = labelsFor(catalogLayer(draft.result), catalog)
  const count = (layer: string) => catalog?.find((l) => l.name === layer)?.feature_count ?? 0
  const found = new Map<string, Reference>()
  for (const row of rows(draft.tree)) {
    if (row.kind === 'attribute' || !row.layer) continue
    let where: Condition | null
    let text: string
    if (row.kind === 'spatial') {
      where = row.filter ? attributeCondition(row.filter) : null
      const title = labels.layer(row.layer)
      text = where ? describe(row, labels, filterLabels) : t`${title} (alle)`
    } else {
      if (row.fid === null) continue
      where = { op: 'compare', attr: 'fid', cmp: 'eq', value: row.fid }
      text = describe(row, labels)
    }
    const key = `${row.layer}:${JSON.stringify(where)}`
    if (found.has(key)) continue
    found.set(key, {
      key,
      layer: row.layer,
      text,
      query: where ? mapQuery(row.layer, where) : null,
      limited: where !== null && count(row.layer) > (maxFeatures ?? Infinity),
    })
  }
  return [...found.values()]
}
