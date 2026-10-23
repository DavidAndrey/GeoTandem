// The reference of a follow-up prompt (plan P6, design M11). The dialogue keeps
// the latest answer as the reference (``useModel.reference``); the field shows
// it above the input, × asks without it (M11.1). What the reference amounts to
// is the server's to decide, from the analysis sent along (P6): the label here
// only says the same in advance, "letzte Antwort" while the analysis is the
// answer's query, "aktuelle Analyse" once it was changed by hand (M11.2). The
// map's restriction ("Nur in") is the user's on both sides and left out.
//
// An answer is stale (M11.3) when its query names a layer the account no longer
// has for the model: deleted, no longer visible or no longer released for the
// model, the layers the server checks. A closed answer then says so in place of
// its card; an open one keeps its card and controls, so it can still be
// declined. Neither is a reference: the server would refuse it as
// ``stale_reference``. The design says "aus der Analyse entfernt", but a
// relation's layer need not be on the map at all (applying adds only the result
// layer), so the catalog is what the answer depends on.
import type { Analysis } from '../../analysis/model'
import { resultQuery } from '../../analysis/query'
import type { ModelActionView } from '../../api/client'
import { useLayers } from '../../api/queries'
import { sameQuery } from '../panel/handover'

export type ReferenceKind = 'last_answer' | 'current'

/** What a follow-up to ``view`` refers to, as the server will derive it (P6). */
export function referenceKind(view: ModelActionView, analysis: Analysis): ReferenceKind {
  // An answer without a query (a cannot-answer) leaves nothing to compare (P6).
  if (view.query == null) return 'last_answer'
  const query = resultQuery({ ...analysis, restriction: null })
  return sameQuery(query, view.query) ? 'last_answer' : 'current'
}

/** Keys of a query object that name a catalog layer (``LAYER_KEYS`` of represent.py). */
const LAYER_KEYS = ['source', 'layer', 'by_layer']

/**
 * The layers a query object names: its source and those of relations,
 * references, joins and aggregations. A symbology's keys are attribute values.
 */
export function queryLayers(query: unknown): string[] {
  const found = new Set<string>()
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk)
    else if (value !== null && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        if (key === 'symbology') continue
        if (LAYER_KEYS.includes(key) && typeof inner === 'string') found.add(inner)
        else walk(inner)
      }
    }
  }
  walk(query)
  return [...found]
}

/** The first layer of ``view``'s query the catalog no longer has, or ``null`` (M11.3). */
export function staleLayer(view: ModelActionView, catalog: readonly string[]): string | null {
  if (view.query == null) return null
  return queryLayers(view.query).find((layer) => !catalog.includes(layer)) ?? null
}

/** ``staleLayer`` against the layers released for the model; nothing is stale before they load. */
export function useStaleLayer(view: ModelActionView | undefined): string | null {
  const { data } = useLayers()
  if (!view || !data) return null
  const released = data.filter((layer) => layer.for_model).map((layer) => layer.name)
  return staleLayer(view, released)
}
