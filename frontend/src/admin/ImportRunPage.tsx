// One import attempt (design D8): who, what, how long, what went wrong, and
// the decisions taken in the wizard.
import { i18n, type MessageDescriptor } from '@lingui/core'
import { Trans } from '@lingui/react/macro'
import { msg, t } from '@lingui/core/macro'
import { AlertTriangle, Check, X } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { useImportRun } from '../api/queries'
import { ErrorNotice, Loading, StatusBadge } from '../components/ui'
import { formatDateTime, importedText, recordCount } from './format'
import { formatNumber } from '../i18n/locale'

const STEP_LABELS: Record<string, MessageDescriptor> = {
  read: msg`Datei gelesen`,
  check: msg`Entscheidungen geprüft`,
  geometry: msg`Geometrien gebildet`,
  store: msg`Layer und Raumindex angelegt`,
}

const seconds = (ms: number) => `${formatNumber(ms / 1000, { maximumFractionDigits: 1 })} s`

export function ImportRunPage() {
  const id = Number(useParams().id)
  const run = useImportRun(id)
  const [showRows, setShowRows] = useState(false)

  if (run.isPending) return <Loading />
  if (!run.data) return <ErrorNotice error={run.error} />
  const r = run.data
  const source = r.source_name
  const succeeded = r.status === 'ok' || r.status === 'warning'
  const rowColumns = Object.keys(r.rejected_sample[0]?.values ?? {})

  return (
    <section aria-labelledby="run-title" className="card max-w-4xl">
      <div className="border-divider flex items-center gap-3 border-b px-5 py-3">
        <h2 id="run-title" className="text-xl">
          <Trans>Import · {source}</Trans>
        </h2>
        <StatusBadge status={r.status} />
        {r.layer_name && succeeded && (
          <Link to={`/admin/daten/import?ziel=${r.layer_name}`} className="btn ml-auto">
            <Trans>Erneut importieren</Trans>
          </Link>
        )}
      </div>
      <div className="flex flex-col gap-4 px-5 py-4">
        <dl className="grid grid-cols-4 gap-3 text-sm">
          <div>
            <dt className="label-caps">
              <Trans>Zeitpunkt</Trans>
            </dt>
            <dd>{formatDateTime(r.started_at)}</dd>
          </div>
          <div>
            <dt className="label-caps">
              <Trans>Von</Trans>
            </dt>
            <dd>{r.actor ?? '–'}</dd>
          </div>
          <div>
            <dt className="label-caps">
              <Trans>Quelle</Trans>
            </dt>
            <dd>
              {r.source_format} · {recordCount(r.read_count)}
            </dd>
          </div>
          <div>
            <dt className="label-caps">
              <Trans>Ziel</Trans>
            </dt>
            <dd>
              {r.layer_name && succeeded ? (
                <Link to={`/admin/daten/${r.layer_name}`} className="text-accent-700 underline">
                  {r.layer_name}
                </Link>
              ) : (
                (r.layer_name ?? '–')
              )}{' '}
              {r.mode === 'replace' && '(aktualisiert)'}
            </dd>
          </div>
        </dl>

        <div>
          <p className="label-caps mb-1">
            <Trans>Ablauf</Trans>
          </p>
          <ul className="flex flex-col gap-1 text-sm">
            {r.steps.map((s) => (
              <li key={s.step} className="flex items-center gap-2">
                <Check size={14} aria-hidden />
                {STEP_LABELS[s.step] ? i18n._(STEP_LABELS[s.step]) : s.step}
                <span className="text-muted ml-auto">{seconds(s.ms)}</span>
              </li>
            ))}
            {r.warnings.map((w, i) => (
              <li key={`w${i}`} className="flex items-center gap-2">
                <AlertTriangle size={14} className="text-accent-700" aria-label={t`Warnung`} />
                {w.message}
                {w.code === 'rejected_rows' && r.rejected_sample.length > 0 && (
                  <button
                    type="button"
                    className="btn ml-auto text-sm"
                    aria-expanded={showRows}
                    onClick={() => setShowRows(!showRows)}
                  >
                    <Trans>Zeilen</Trans> {showRows ? '↑' : '↓'}
                  </button>
                )}
              </li>
            ))}
            {r.errors.map((e, i) => (
              <li key={`e${i}`} className="text-danger flex items-center gap-2">
                <X size={14} aria-label={t`Fehler`} />
                {e.message}
              </li>
            ))}
            {r.status === 'aborted' && (
              <li className="text-muted">
                <Trans>Im Assistenten abgebrochen.</Trans>
              </li>
            )}
            {succeeded && (
              <li className="flex items-center gap-2">
                <Check size={14} aria-hidden />
                {importedText(r)}
              </li>
            )}
          </ul>
        </div>

        {showRows && (
          <div className="overflow-auto">
            <table className="data-table text-xs">
              <thead>
                <tr>
                  <th>
                    <Trans>Zeile</Trans>
                  </th>
                  <th>
                    <Trans>Grund</Trans>
                  </th>
                  {rowColumns.map((c) => (
                    <th key={c}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {r.rejected_sample.map((row) => (
                  <tr key={row.row}>
                    <td>{row.row}</td>
                    <td>{row.reason}</td>
                    {rowColumns.map((c) => (
                      <td key={c}>{String(row.values[c] ?? '')}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {Object.keys(r.decisions).length > 0 && (
          <details>
            <summary className="label-caps cursor-pointer">
              <Trans>Entscheidungen im Assistenten</Trans>
            </summary>
            <pre className="mt-2 overflow-auto text-xs">{JSON.stringify(r.decisions, null, 2)}</pre>
          </details>
        )}
      </div>
    </section>
  )
}
