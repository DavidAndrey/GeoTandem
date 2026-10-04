// The features of a displayed layer and the result's hits, fetched once and
// shared by the map and the attribute table (plan E1.6 D2): one query per
// layer, one truth, never a second path past the engine.
import { keepPreviousData, useQuery } from '@tanstack/react-query'
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

/**
 * Ids of the features ``query`` returns; ``null`` while it has no conditions (design B9).
 * Only the ids travel, so hits beyond the result-size limit are still marked.
 */
export function useHits(query: QueryObject | null) {
  const result = useQuery({
    queryKey: ['map-hits', query],
    queryFn: () => (query ? api.ids(query) : null),
    enabled: Boolean(query?.where),
  })
  const ids = query?.where && result.data ? new Set(result.data.ids) : null
  return { ...result, ids }
}
