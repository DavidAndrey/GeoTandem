// The model log through TanStack Query (plan WP73): the administrators' list,
// its key figures and one entry; the account's own entries (D4, design M16.3).
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { api, type ModelLogFilter } from '../../api/client'

export const PAGE = 50

export const logKeys = {
  list: (filter: ModelLogFilter, offset: number) =>
    ['admin', 'model-log', 'list', filter, offset] as const,
  figures: (filter: ModelLogFilter) => ['admin', 'model-log', 'figures', filter] as const,
  entry: (id: number) => ['admin', 'model-log', 'entry', id] as const,
  mine: ['model', 'my-actions'] as const,
}

export const useModelLog = (filter: ModelLogFilter, offset: number) =>
  useQuery({
    queryKey: logKeys.list(filter, offset),
    queryFn: () => api.admin.modelActions(filter, offset, PAGE),
    // The page stays while the next one loads: no jump of the table.
    placeholderData: keepPreviousData,
  })

export const useKeyFigures = (filter: ModelLogFilter) =>
  useQuery({
    queryKey: logKeys.figures(filter),
    queryFn: () => api.admin.modelKeyFigures(filter),
    placeholderData: keepPreviousData,
  })

export const useLogEntry = (id: number) =>
  useQuery({ queryKey: logKeys.entry(id), queryFn: () => api.admin.modelAction(id) })

/** The account's own entries, a page at a time; fetched while the dialog is open only. */
export const useMyActions = (enabled: boolean) =>
  useInfiniteQuery({
    queryKey: logKeys.mine,
    queryFn: ({ pageParam }) => api.model.myActions(pageParam, PAGE),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, page) => n + page.items.length, 0)
      return loaded < last.total && last.items.length > 0 ? loaded : undefined
    },
    enabled,
    // Always the current state when the dialog opens.
    staleTime: 0,
  })
