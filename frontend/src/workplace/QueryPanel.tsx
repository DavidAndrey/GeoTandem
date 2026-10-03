// The global query (design B1): one result layer per session, "7 von 39".
// The condition editor (B2) joins in WP23.
import { useShallow } from 'zustand/react/shallow'
import { useQuery } from '@tanstack/react-query'
import { canBeResult, resultQuery, totalQuery } from '../analysis/query'
import { currentAnalysis, useAnalysis } from '../analysis/store'
import { api } from '../api/client'
import { useLayers } from '../api/queries'
import { ErrorNotice } from '../components/ui'
import { layerTitle } from './layerInfo'

export function QueryPanel() {
  const analysis = useAnalysis(useShallow(currentAnalysis))
  const setResult = useAnalysis((s) => s.setResult)
  const catalog = useLayers()
  const total = totalQuery(analysis)
  const result = resultQuery(analysis)
  const counts = useQuery({
    queryKey: ['counts', total, result],
    queryFn: () => (total && result ? api.count([result, total]) : null),
    enabled: Boolean(total && result),
  })
  const candidates = analysis.layers.filter(canBeResult)
  const [hits, of] = counts.data?.counts ?? []

  return (
    <section aria-labelledby="query-title">
      <div className="mb-1 flex items-center">
        <h2 id="query-title" className="label-caps flex-1">
          Abfrage
        </h2>
        {hits !== undefined && (
          <span className="text-sm" aria-label="Trefferzahl">
            {hits} von {of}
          </span>
        )}
      </div>
      {candidates.length === 0 ? (
        <p className="text-muted text-sm">Erst einen Layer hinzufügen; er wird Ergebnis-Layer.</p>
      ) : (
        <label className="flex items-center gap-2 text-sm">
          Ergebnis:
          <select
            className="input flex-1"
            value={analysis.result ?? ''}
            onChange={(e) => setResult(e.target.value)}
          >
            {analysis.result === null && <option value="">–</option>}
            {candidates.map((layer) => (
              <option key={layer.id} value={layer.id}>
                {layerTitle(layer, catalog.data)}
              </option>
            ))}
          </select>
        </label>
      )}
      <ErrorNotice error={counts.error} />
    </section>
  )
}
