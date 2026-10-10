// The model log (design M16.1, F-6.8, F-6.9): every account's model actions
// with the key figures of plan section 2 above them. List, figures and the
// CSV follow the same filters (period, level, connection, approach, account);
// the filters live in the address, so a link keeps them.
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { api, type Approach, type ModelLogFilter } from '../api/client'
import { useConnections, useLevels } from '../api/queries'
import { ErrorNotice, Loading } from '../components/ui'
import { errorText } from '../i18n/errors'
import { formatNumber } from '../i18n/locale'
import { KeyFigureRow } from '../model/log/KeyFigureRow'
import { MAX_EXPORT_ROWS, PAGE, useKeyFigures, useModelLog } from '../model/log/queries'
import {
  approachShort,
  approachText,
  DEFAULT_PERIOD,
  outcomeText,
  PERIODS,
  periodStart,
  periodText,
  type Period,
} from '../model/log/words'
import { formatDateTime } from './format'

const APPROACHES: Approach[] = ['direct', 'chain']

const readPeriod = (value: string | null): Period => {
  if (value === 'alle') return null
  const days = Number(value)
  return PERIODS.find((p) => p === days) ?? DEFAULT_PERIOD
}

const onlyFrom = (account: string) => t`Nur Einträge von ${account}`

const readId = (value: string | null) => {
  const id = Number(value)
  return value && Number.isInteger(id) ? id : undefined
}

export function ModelLogPage() {
  const [params, setParams] = useSearchParams()
  // The period ends when the page opened or a filter last changed: list pages,
  // key figures and CSV then hold the same rows while new ones arrive, and the
  // filter stays one cache key.
  const [now, setNow] = useState(() => Date.now())
  const period = readPeriod(params.get('zeitraum'))
  const levelId = readId(params.get('stufe'))
  const connectionId = readId(params.get('anbindung'))
  const approach = APPROACHES.find((a) => a === params.get('arbeitsweise'))
  const account = params.get('konto') ?? undefined
  const offset = Math.max(0, readId(params.get('ab')) ?? 0)

  const filter = useMemo<ModelLogFilter>(
    () => ({
      from: periodStart(period, now),
      to: new Date(now).toISOString(),
      level_id: levelId,
      connection_id: connectionId,
      approach,
      account,
    }),
    [period, now, levelId, connectionId, approach, account],
  )
  const log = useModelLog(filter, offset)
  const figures = useKeyFigures(filter)
  const levels = useLevels().data?.levels ?? []
  const connections = useConnections().data ?? []

  /** A changed filter starts at the first page again. */
  const setFilter = (key: string, value: string | undefined) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    if (key !== 'ab') {
      next.delete('ab')
      setNow(Date.now())
    }
    setParams(next, { replace: true })
  }

  const total = log.data?.total ?? 0
  const shown = log.data?.items.length ?? 0
  const first = formatNumber(shown ? offset + 1 : 0)
  const last = formatNumber(offset + shown)
  const all = formatNumber(total)
  const tooLarge = total > MAX_EXPORT_ROWS

  return (
    <section aria-labelledby="model-log-title">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 id="model-log-title" className="mr-auto text-2xl">
          <Trans>Modellprotokoll</Trans>
        </h2>
        <label className="flex items-center gap-2 text-sm">
          <Trans>Zeitraum</Trans>
          <select
            className="input"
            value={period === null ? 'alle' : String(period)}
            onChange={(e) => setFilter('zeitraum', e.target.value)}
          >
            {PERIODS.map((p) => (
              <option key={String(p)} value={p === null ? 'alle' : String(p)}>
                {periodText(p)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Trans>Stufe</Trans>
          <select
            className="input"
            value={levelId ?? ''}
            onChange={(e) => setFilter('stufe', e.target.value || undefined)}
          >
            <option value="">{t`alle`}</option>
            {levelId !== undefined && !levels.some((l) => l.id === levelId) && (
              <option value={levelId}>{t`Stufe ${levelId}`}</option>
            )}
            {levels.map(
              (level) =>
                level.id != null && (
                  <option key={level.id} value={level.id}>
                    {level.name}
                  </option>
                ),
            )}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Trans>Anbindung</Trans>
          <select
            className="input"
            value={connectionId ?? ''}
            onChange={(e) => setFilter('anbindung', e.target.value || undefined)}
          >
            <option value="">{t`alle`}</option>
            {connectionId !== undefined && !connections.some((c) => c.id === connectionId) && (
              <option value={connectionId}>{t`Anbindung ${connectionId}`}</option>
            )}
            {connections.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Trans>Arbeitsweise</Trans>
          <select
            className="input"
            value={approach ?? ''}
            onChange={(e) => setFilter('arbeitsweise', e.target.value || undefined)}
          >
            <option value="">{t`alle`}</option>
            {APPROACHES.map((a) => (
              <option key={a} value={a}>
                {approachText(a)}
              </option>
            ))}
          </select>
        </label>
        {account && (
          <button
            type="button"
            className="chip chip-active"
            aria-label={t`Filter Konto ${account} entfernen`}
            onClick={() => setFilter('konto', undefined)}
          >
            <Trans>Konto {account}</Trans> ✕
          </button>
        )}
        {tooLarge ? (
          <button
            type="button"
            className="btn"
            disabled
            title={errorText('export_too_large', { max: MAX_EXPORT_ROWS })}
          >
            <Trans>CSV</Trans>
          </button>
        ) : (
          <a className="btn" href={api.admin.modelExportUrl(filter)} download>
            <Trans>CSV</Trans>
          </a>
        )}
      </div>
      {tooLarge && (
        <p className="text-muted mb-2 text-xs">
          {errorText('export_too_large', { max: MAX_EXPORT_ROWS })}
        </p>
      )}
      <ErrorNotice error={figures.error} />
      {figures.data && <KeyFigureRow figures={figures.data} />}
      {log.isPending && <Loading />}
      <ErrorNotice error={log.error} />
      {log.data && (
        <>
          <table className="data-table">
            <thead>
              <tr>
                <th>
                  <Trans>Zeit</Trans>
                </th>
                <th>
                  <Trans>Konto</Trans>
                </th>
                <th>
                  <Trans>Prompt</Trans>
                </th>
                <th>
                  <Trans>Stufe</Trans>
                </th>
                <th>
                  <Trans>Arbeitsweise</Trans>
                </th>
                <th>
                  <Trans>Entscheidung</Trans>
                </th>
                <th className="text-right">
                  <Trans>Treffer</Trans>
                </th>
              </tr>
            </thead>
            <tbody>
              {log.data.items.map((entry) => (
                <tr key={entry.id}>
                  <td className="whitespace-nowrap">
                    <Link
                      to={`/admin/modellprotokoll/${entry.id}`}
                      className="hover:text-accent-700"
                    >
                      {formatDateTime(entry.created_at)}
                    </Link>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="hover:text-accent-700 cursor-pointer"
                      title={onlyFrom(entry.account)}
                      onClick={() => setFilter('konto', entry.account)}
                    >
                      {entry.account}
                    </button>
                  </td>
                  <td className="max-w-[26rem] truncate" title={entry.prompt}>
                    {entry.prompt}
                  </td>
                  <td>{entry.level_name}</td>
                  <td>{approachShort(entry.approach)}</td>
                  <td>{outcomeText(entry)}</td>
                  <td className="text-right tabular-nums">
                    {entry.hits === null ? '–' : formatNumber(entry.hits)}
                  </td>
                </tr>
              ))}
              {log.data.items.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-muted py-4 text-center">
                    <Trans>Keine Modellaktionen in diesem Ausschnitt.</Trans>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {total > PAGE && (
            <nav aria-label={t`Seiten`} className="mt-3 flex items-center gap-3 text-sm">
              <button
                type="button"
                className="btn"
                disabled={offset === 0}
                onClick={() => setFilter('ab', offset > PAGE ? String(offset - PAGE) : undefined)}
              >
                <Trans>Neuere</Trans>
              </button>
              <span className="tabular-nums">
                <Trans>
                  {first}–{last} von {all}
                </Trans>
              </span>
              <button
                type="button"
                className="btn"
                disabled={offset + shown >= total}
                onClick={() => setFilter('ab', String(offset + PAGE))}
              >
                <Trans>Ältere</Trans>
              </button>
            </nav>
          )}
        </>
      )}
    </section>
  )
}
