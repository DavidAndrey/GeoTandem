// The runs from the server (plan E3, WP90): the list, one run polled while it
// runs (D8), the answers of a cell, the comparison of two runs.
import { useQuery } from '@tanstack/react-query'
import { api, type RunPage, type RunView } from '../../api/client'

/** How often a running run is asked again; tests shorten it. */
export const poll = { ms: 2000 }

/** Failed polls in a row (each after its retry) after which polling stops. */
const GIVE_UP = 3

/** The query's error count at its last success, to count the failures since. */
const errorsAtSuccess = new Map<string, number>()

interface Polled<T> {
  queryHash: string
  state: {
    status: string
    data: T | undefined
    dataUpdatedAt: number
    errorUpdatedAt: number
    errorUpdateCount: number
  }
}

/**
 * Polling goes on while ``active``; a failed poll keeps the data and polling,
 * failures in a row stop it (the page shows the error above what it read).
 */
function every<T>(query: Polled<T>, active: (data: T | undefined) => boolean) {
  const s = query.state
  if (s.status !== 'error' || s.errorUpdatedAt < s.dataUpdatedAt)
    errorsAtSuccess.set(query.queryHash, s.errorUpdateCount)
  const failures = s.errorUpdateCount - (errorsAtSuccess.get(query.queryHash) ?? 0)
  if (failures >= GIVE_UP) return false
  return active(s.data) ? poll.ms : false
}

export const runKeys = {
  all: ['eval-runs'] as const,
  list: ['eval-runs', 'list'] as const,
  one: (id: number) => ['eval-runs', 'one', id] as const,
  answers: (id: number, caseId: string, point: number) =>
    ['eval-runs', 'answers', id, caseId, point] as const,
  byConnection: (id: number) => ['eval-runs', 'connection', id] as const,
  comparison: (run: number, against: number) => ['eval-runs', 'comparison', run, against] as const,
}

/** The newest runs (a page of 50): V5 and "a run is running" of V4.2. */
export const useRuns = (refresh = false) =>
  useQuery({
    queryKey: runKeys.list,
    queryFn: () => api.evaluation.runs(),
    // While one runs, the list follows it (status and percent).
    refetchInterval: (query) =>
      every<RunPage>(query, (data) => refresh || !!data?.items.some((r) => r.status === 'running')),
  })

const running = (run: RunView | undefined) => run?.status === 'running'

/** One run; polled while it runs, until done, aborted, interrupted or failed. */
export const useRun = (id: number, enabled = true) =>
  useQuery({
    queryKey: runKeys.one(id),
    queryFn: () => api.evaluation.run(id),
    enabled: enabled && Number.isInteger(id) && id > 0,
    refetchInterval: (query) => every<RunView>(query, running),
  })

export const useAnswers = (id: number, caseId: string, point: number, enabled = true) =>
  useQuery({
    queryKey: runKeys.answers(id, caseId, point),
    queryFn: () => api.evaluation.answers(id, caseId, point),
    enabled,
  })

export const useComparison = (run: number, against: number) =>
  useQuery({
    queryKey: runKeys.comparison(run, against),
    queryFn: () => api.evaluation.compare(run, against),
  })

/** The last run that measured a connection: "zuletzt bewertet" (O7). */
export const useLastRun = (connectionId: number) =>
  useQuery({
    queryKey: runKeys.byConnection(connectionId),
    queryFn: () => api.evaluation.runs({ connectionId, limit: 1 }),
    select: (page) => page.items[0] ?? null,
  })
