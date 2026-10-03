// Hit counts for the query editor and the sidebar (design B1, B2), through the
// counting endpoint: numbers only, no features.
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import type { Analysis } from '../analysis/model'
import { resultQuery, rowQueries, totalQuery } from '../analysis/query'
import { api } from '../api/client'

/** Hits of each condition alone, of the whole query, and of the layer (design B2). */
export function useCounts(analysis: Analysis) {
  const debounced = useDebounced(analysis, 300)
  const rows = rowQueries(debounced)
  const result = resultQuery(debounced)
  const total = totalQuery(debounced)
  const counts = useQuery({
    queryKey: ['counts', rows, result, total],
    queryFn: async () => {
      if (!result || !total) return null
      const { counts } = await api.count([result, total, ...rows.map((r) => r.query)])
      return {
        hits: counts[0] ?? 0,
        total: counts[1] ?? 0,
        rows: new Map(rows.map((r, i) => [r.id, counts[i + 2] ?? 0])),
      }
    },
    placeholderData: (previous) => previous,
  })
  return counts
}

function useDebounced<T>(value: T, ms: number): T {
  const [current, setCurrent] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setCurrent(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return current
}
