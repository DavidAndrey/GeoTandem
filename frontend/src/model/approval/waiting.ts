// The proposal that waits for approval and its preview (design M5.1, M5.2;
// plan P2), shared by the approval, the map's dashed layer and the header.
import { useQuery } from '@tanstack/react-query'
import { api, type ModelActionView } from '../../api/client'
import type { ModelState } from '../store'
import { needsApproval } from './governance'

/** The one proposal that waits for approval, if any (design M5.2: at most one). */
export const awaiting = (state: ModelState): ModelActionView | null => {
  const view = state.pending !== null ? state.views[state.pending] : undefined
  return view && needsApproval(view) ? view : null
}

/**
 * The preview of ``view`` while it waits for approval (P2): the stored query
 * run by the user's own session. Not fetched otherwise, so never for a level
 * with ``off`` parts; the model never sees it.
 */
export function usePreview(view: ModelActionView | null) {
  return useQuery({
    queryKey: ['model-preview', view?.id ?? null],
    queryFn: () => api.model.preview(view?.id ?? 0),
    enabled: view !== null && needsApproval(view),
    retry: false,
    staleTime: Infinity,
  })
}
