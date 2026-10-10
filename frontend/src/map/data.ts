// The features of a displayed layer and the result's hits, fetched once and
// shared by the map and the attribute table (plan E1.6 D2): one query per
// layer, one truth, never a second path past the engine.
import { keepPreviousData, useQuery, type QueryClient } from '@tanstack/react-query'
import type { QueryObject } from '../analysis/model'
import { and } from '../analysis/query'
import { api } from '../api/client'
import { roundBbox, useMapView } from './view'

/**
 * All features ``query`` describes; too large ones only within the current view (plan D5).
 * ``viewed`` tells whether the answer is limited to the view.
 */
export function useLayerFeatures(query: QueryObject, largerThanLimit: boolean, enabled = true) {
  const bbox = useMapView((s) => s.bbox)
  const viewed = largerThanLimit && bbox ? roundBbox(bbox) : null
  const effective: QueryObject = viewed
    ? { ...query, where: and(query.where, { op: 'bbox', bbox: viewed }) ?? undefined }
    : query
  const result = useQuery({
    queryKey: ['map-layer', effective],
    queryFn: () => api.query(effective),
    placeholderData: keepPreviousData,
    enabled,
  })
  return { ...result, viewed: viewed !== null }
}

const hitsKey = (query: QueryObject | null) => ['map-hits', query] as const

/** Hit sets ``seedHits`` put in the cache, with the time of the seed: fresh while unchanged. */
const seeded = new WeakMap<object, number>()

/**
 * Ids of the features ``query`` returns; ``null`` while it has no conditions (design B9).
 * Only the ids travel, so hits beyond the result-size limit are still marked.
 */
export function useHits(query: QueryObject | null) {
  const result = useQuery({
    queryKey: hitsKey(query),
    queryFn: () => (query ? api.ids(query) : null),
    enabled: Boolean(query?.where),
    // A seeded hit set is the run the server just made: not asked for again.
    staleTime: (cached) => (seeded.get(cached) === cached.state.dataUpdatedAt ? Infinity : 0),
  })
  const ids = query?.where && result.data ? new Set(result.data.ids) : null
  return { ...result, ids }
}

/**
 * The hits of ``query`` as a run of the server returned them (a model change's
 * ``execute``, plan D2): the map and the table show exactly what the log's
 * stamp counted, and the query is not run a second time. ``query`` must be the
 * one ``useHits`` gets for the analysis (``resultQuery``), ``ids`` all of its
 * features: a run is never cut at the result-size limit, it fails instead.
 */
export function seedHits(client: QueryClient, query: QueryObject, ids: readonly number[]) {
  client.setQueryData(hitsKey(query), { ids: [...ids].sort((a, b) => a - b) })
  const seed = client.getQueryCache().find({ queryKey: hitsKey(query), exact: true })
  if (seed) seeded.set(seed, seed.state.dataUpdatedAt)
}
