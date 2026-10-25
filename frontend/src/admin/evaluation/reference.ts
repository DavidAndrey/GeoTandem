// A case's reference and the workplace's analysis (design V2.1, V3): which
// analysis the controls show for a reading, and which reference an analysis
// gives, or why it cannot be one. Pure, so they are unit-tested.
import { t } from '@lingui/core/macro'
import type { Analysis, DisplayLayer, QueryPart } from '../../analysis/model'
import { emptyTree, resultLayer, resultQuery, toAnalysis } from '../../analysis/query'
import { rows } from '../../analysis/tree'
import type { LayerInfo } from '../../api/client'
import { errorText } from '../../i18n/errors'
import { MAX_CONDITIONS, referenceOf, tooManyConditions } from './words'

/** The analysis the controls show for a reading, or ``null`` if they cannot show it (D3). */
export function partOf(
  reading: Record<string, unknown>,
  catalog: readonly LayerInfo[] | undefined,
): QueryPart | null {
  return toAnalysis(reading, catalog).analysis
}

/** A query part as an analysis on its catalog layer, for the hit counts (B2). */
export function analysisOf(part: QueryPart | null): Analysis {
  if (!part) return { layers: [], result: null, tree: emptyTree(), restriction: null }
  const layer: DisplayLayer = {
    id: part.result,
    source: { kind: 'catalog', layer: part.result },
    visible: true,
    opacity: 1,
    symbology: null,
  }
  return { layers: [layer], result: layer.id, tree: part.tree, restriction: null }
}

interface Found {
  gold: Record<string, unknown>
  /** The query's schema version, which the case names beside its reference. */
  schemaVersion: string
  problem: null
}

/** The analysis as the map shows it: the applied tree, never an open draft of the editor. */
export const appliedAnalysis = (s: Analysis & { tree: Analysis['tree'] }): Analysis => ({
  layers: s.layers,
  result: s.result,
  tree: s.tree,
  restriction: s.restriction,
})

/**
 * The reference a case would get from ``analysis``, or why it cannot be one
 * (V3.2): what the controls can tell before the server checks it as a model's
 * query (``validate_model_query``): a catalog layer as the result, at most
 * ``MAX_CONDITIONS`` conditions, no restriction, nothing the controls cannot show.
 */
export function referenceFor(
  analysis: Analysis,
  catalog: readonly LayerInfo[] | undefined,
): Found | { gold: null; problem: string } {
  const layer = resultLayer(analysis)
  const query = resultQuery(analysis)
  if (!layer || !query) return { gold: null, problem: t`Die Analyse hat keinen Ergebnis-Layer.` }
  if (layer.source.kind !== 'catalog')
    return {
      gold: null,
      problem: t`Das Ergebnis ist ein abgeleiteter Layer. Ein Prüffall braucht einen Layer des Katalogs als Ergebnis, wie jede Direktabfrage des Modells.`,
    }
  const conditions = rows(analysis.tree).length + (analysis.restriction ? 1 : 0)
  if (conditions > MAX_CONDITIONS) return { gold: null, problem: tooManyConditions(conditions) }
  if (analysis.restriction)
    return {
      gold: null,
      problem: t`Die Einschränkung „Nur in" gehört zur Karte; eine Modellantwort kann sie nicht enthalten. Heben Sie sie zuerst auf.`,
    }
  const gold = referenceOf(query)
  if (!partOf(gold, catalog)) return { gold: null, problem: errorText('not_representable') }
  return { gold, schemaVersion: query.schema_version ?? '2', problem: null }
}

/** Why a query cannot open in the workplace (V2.1, V7.2): the controls cannot show it. */
export const notOpenable = () =>
  t`Die Abfrage lässt sich im Arbeitsplatz nicht darstellen: Ein Layer fehlt dort, oder sie nutzt mehr, als die Bedienelemente zeigen.`
