// Import log (design D7, F-2.10): every attempt, including failed and aborted ones.
import { Link, useSearchParams } from 'react-router'
import type { ImportStatus } from '../api/client'
import { useImportLog } from '../api/queries'
import { ErrorNotice, Loading, StatusBadge } from '../components/ui'
import { formatDateTime, STATUS_LABELS } from './format'

const STATUSES = Object.keys(STATUS_LABELS) as ImportStatus[]

export function ImportLogPage() {
  const [params, setParams] = useSearchParams()
  const status = STATUSES.find((s) => s === params.get('status'))
  const layer = params.get('layer') ?? undefined
  const log = useImportLog({ status, layer })

  const setFilter = (key: string, value: string | undefined) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    setParams(next, { replace: true })
  }

  return (
    <section aria-labelledby="log-title">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 id="log-title" className="text-2xl">
          Importprotokoll
        </h2>
        <label className="flex items-center gap-2 text-sm">
          Status
          <select
            className="input"
            value={status ?? ''}
            onChange={(e) => setFilter('status', e.target.value || undefined)}
          >
            <option value="">alle</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        {layer && (
          <button
            type="button"
            className="chip chip-active"
            onClick={() => setFilter('layer', undefined)}
          >
            Layer {layer} ✕
          </button>
        )}
      </div>
      {log.isPending && <Loading />}
      <ErrorNotice error={log.error} />
      {log.data && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Zeitpunkt</th>
              <th>Quelle</th>
              <th>Layer</th>
              <th>Vorgang</th>
              <th>Ergebnis</th>
              <th className="text-right">Übernommen</th>
              <th>Von</th>
            </tr>
          </thead>
          <tbody>
            {log.data.map((run) => (
              <tr key={run.id}>
                <td>
                  <Link to={`/admin/protokoll/${run.id}`} className="hover:text-accent-700">
                    {formatDateTime(run.started_at)}
                  </Link>
                </td>
                <td>{run.source_name}</td>
                <td>
                  {run.layer_name ? (
                    <button
                      type="button"
                      className="hover:text-accent-700 cursor-pointer"
                      onClick={() => setFilter('layer', run.layer_name ?? undefined)}
                    >
                      {run.layer_name}
                    </button>
                  ) : (
                    '–'
                  )}
                </td>
                <td>{run.mode === 'replace' ? 'Aktualisierung' : 'Neu'}</td>
                <td>
                  <StatusBadge status={run.status} />
                </td>
                <td className="text-right">
                  {run.imported_count} / {run.read_count}
                </td>
                <td>{run.actor ?? '–'}</td>
              </tr>
            ))}
            {log.data.length === 0 && (
              <tr>
                <td colSpan={7} className="text-muted py-4 text-center">
                  Keine Importe.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </section>
  )
}
