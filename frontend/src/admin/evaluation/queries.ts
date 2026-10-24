// The cases from the server (plan E3, WP87): the whole list in pages, one case
// with its hits, and the changes that refresh both.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type CasePage, type CaseView, type EvalCase } from '../../api/client'
import { caseBody } from './words'

/** Page size of the case list (``MAX_PAGE`` of the server). */
const PAGE = 200

export const caseKeys = {
  all: ['eval-cases'] as const,
  list: ['eval-cases', 'list'] as const,
  one: (id: string) => ['eval-cases', 'one', id] as const,
}

/** Start set and own cases together are at most 500: a few pages, read as one list. */
async function allCases(): Promise<CasePage> {
  const items: CaseView[] = []
  for (;;) {
    const page = await api.evaluation.cases(items.length, PAGE)
    items.push(...page.items)
    if (items.length >= page.total || page.items.length === 0) return { items, total: page.total }
  }
}

export const useCases = () => useQuery({ queryKey: caseKeys.list, queryFn: allCases })

export const useCase = (id: string) =>
  useQuery({ queryKey: caseKeys.one(id), queryFn: () => api.evaluation.case(id) })

/** Creates, edits or deletes a case and refreshes list and detail. */
export function useCaseChange<T, R>(change: (args: T) => Promise<R>) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: change,
    onSuccess: () => client.invalidateQueries({ queryKey: caseKeys.all }),
  })
}

export const createCase = (c: EvalCase) => api.evaluation.create(caseBody(c))
export const updateCase = ({ id, body }: { id: string; body: EvalCase }) =>
  api.evaluation.update(id, caseBody(body))
