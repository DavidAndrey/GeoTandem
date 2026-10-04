// Import log (design D7, F-2.10): every attempt, including failed and aborted ones.
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { Link, useSearchParams } from 'react-router'
import { useImportLog } from '../api/queries'
import { ErrorNotice, Loading, StatusBadge } from '../components/ui'
import { formatDateTime, statusLabel, STATUSES } from './format'

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
          <Trans>Importprotokoll</Trans>
        </h2>
        <label className="flex items-center gap-2 text-sm">
          <Trans>Status</Trans>
          <select
            className="input"
            value={status ?? ''}
            onChange={(e) => setFilter('status', e.target.value || undefined)}
          >
            <option value="">{t`alle`}</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
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
            <Trans>Layer {layer}</Trans> ✕
          </button>
        )}
      </div>
      {log.isPending && <Loading />}
      <ErrorNotice error={log.error} />
      {log.data && (
        <table className="data-table">
          <thead>
            <tr>
              <th>
                <Trans>Zeitpunkt</Trans>
              </th>
              <th>
                <Trans>Quelle</Trans>
              </th>
              <th>
                <Trans>Layer</Trans>
              </th>
              <th>
                <Trans>Vorgang</Trans>
              </th>
              <th>
                <Trans>Ergebnis</Trans>
              </th>
              <th className="text-right">
                <Trans>Übernommen</Trans>
              </th>
              <th>
                <Trans>Von</Trans>
              </th>
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
                <td>{run.mode === 'replace' ? t`Aktualisierung` : t`Neu`}</td>
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
                  <Trans>Keine Importe.</Trans>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </section>
  )
}
