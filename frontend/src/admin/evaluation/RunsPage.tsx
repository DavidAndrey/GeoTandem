// Bewertung › Läufe (design V5): the runs with what they measured, their
// status in the language of E2, the reference column's rate and the cost; two
// complete runs over the same cases can be put side by side (D7): once one is
// marked, the runs it cannot be compared with are locked, with the reason.
// Each row names its connections, shows the run's note under its number and
// opens its run on a click anywhere in it. Empty: the smallest sensible first run (V5.2).
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { useId, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import type { ConnectionInfo, RunStatus, RunSummary } from '../../api/client'
import { useConnections } from '../../api/queries'
import { ErrorNotice, Loading } from '../../components/ui'
import { formatDateTime } from '../format'
import { StatusLabel } from '../../model/status'
import { useRun, useRuns } from './runs'
import {
  comparable,
  connectionNames,
  markBlocked,
  NEW_RUN,
  runPath,
  moniesText,
  progressPercent,
  rateText,
  runStatusKey,
  scopeShort,
} from './runWords'
import { rowOpener } from './rowOpener'
import { dataStateText } from './words'

/** A run's status as a label; a running one with its progress in percent. */
export function RunStatusLabel({
  status,
  quick,
  percent,
  live,
}: {
  status: RunStatus
  quick?: boolean
  percent?: number
  live?: boolean
}) {
  let detail: string | undefined
  if (status === 'running' && percent !== undefined) detail = `· ${percent} %`
  else if (status === 'done' && quick) detail = t`· Schnelltest`
  // A finished run is solid (design V5); every other state as E2 draws it.
  return (
    <StatusLabel
      status={runStatusKey(status)}
      detail={detail}
      live={live}
      line={status === 'done' ? 'applied' : undefined}
    />
  )
}

/** The running run's label follows its progress. */
function RunningLabel({ id }: { id: number }) {
  const run = useRun(id).data
  const percent = run ? progressPercent(run.progress.done, run.progress.total) : undefined
  return <RunStatusLabel status="running" percent={percent} />
}

/** "4 Messpunkte · 71 Fälle · Beispieldaten · Vollständig". */
const measured = (r: RunSummary) => {
  const points = r.points
  const cases = r.cases
  const state = dataStateText(r.data_state)
  const scope = scopeShort(r.scope)
  return t`${points} Messpunkte · ${cases} Fälle · ${state} · ${scope}`
}

/** Cost so far or in total; without a price "lokal" or "kein Preis" (O4). */
function costText(r: RunSummary, connections: ConnectionInfo[] | undefined): string {
  const money = moniesText(r.cost)
  if (money) return r.status === 'running' ? t`${money} bisher` : money
  const local = r.connection_ids.every(
    (id) => connections?.find((c) => c.id === id)?.locality === 'local',
  )
  return local ? t`lokal` : t`kein Preis`
}

function Empty() {
  return (
    <div className="card max-w-2xl border-dashed p-4">
      <h3 className="mb-1 text-base">
        <Trans>Noch keine Bewertung</Trans>
      </h3>
      <p className="mb-3 text-sm">
        <Trans>
          Ein Lauf stellt dieselben Fragen an eine oder mehrere Anbindungen und zählt, wie oft die
          Antwort stimmt. Für einen ersten Eindruck: Startbestand, eine Anbindung, Schnelltest (≈ 5
          min lokal).
        </Trans>
      </p>
      <Link to={`${NEW_RUN}?umfang=schnell`} className="btn btn-primary">
        <Trans>Neuer Lauf</Trans>
      </Link>
    </div>
  )
}

export function RunsPage() {
  const runs = useRuns()
  const connections = useConnections().data
  const [marked, setMarked] = useState<number[]>([])
  const navigate = useNavigate()
  const why = useId()
  const items = runs.data?.items ?? []
  const chosen = marked
    .map((id) => items.find((r) => r.id === id))
    .filter((r): r is RunSummary => r !== undefined)
  const count = chosen.length
  const ready = chosen.length === 2 && comparable(chosen[0], chosen[1]) === null
  const hint = ready
    ? t`Bereit zum Gegenüberstellen.`
    : chosen.length === 1
      ? t`Einen zweiten fertigen Lauf mit gleichen Fällen markieren; die übrigen sind gesperrt.`
      : t`Zwei fertige Läufe mit gleichen Fällen markieren.`
  const toggle = (id: number) =>
    setMarked((m) => (m.includes(id) ? m.filter((x) => x !== id) : [...m, id]))
  return (
    <div className="max-w-6xl">
      {runs.isPending && <Loading />}
      <ErrorNotice error={runs.error} />
      {runs.data && items.length === 0 && <Empty />}
      {items.length > 0 && (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-3 text-sm">
            <span aria-live="polite">{t`${count} markiert`}</span>
            <button
              type="button"
              className="btn"
              disabled={!ready}
              aria-describedby={why}
              onClick={() => ready && navigate(`${runPath(chosen[0].id)}/gegen/${chosen[1].id}`)}
            >
              <Trans>Gegenüberstellen</Trans>
            </button>
            <span id={why} className="text-muted text-xs" aria-live="polite">
              {hint}
            </span>
            <Link to={NEW_RUN} className="btn btn-primary ml-auto">
              <Trans>Neuer Lauf</Trans>
            </Link>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">
                  <span className="sr-only">
                    <Trans>Markieren</Trans>
                  </span>
                </th>
                <th scope="col">
                  <Trans>Lauf</Trans>
                </th>
                <th scope="col">
                  <Trans>Wann · wer</Trans>
                </th>
                <th scope="col">
                  <Trans>Anbindungen</Trans>
                  <span className="text-muted block text-xs font-normal">
                    <Trans>Messpunkte · Fälle · Datenstand · Umfang</Trans>
                  </span>
                </th>
                <th scope="col">
                  <Trans>Status</Trans>
                </th>
                <th scope="col">
                  <Trans>Vergleichsbasis</Trans>
                  <sup aria-hidden="true">*</sup>
                </th>
                <th scope="col">
                  <Trans>Kosten</Trans>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => {
                const id = r.id
                const blocked = markBlocked(r, chosen)
                const names = connectionNames(r.connection_ids, connections)
                return (
                  <tr key={r.id} {...rowOpener(() => navigate(runPath(r.id)))}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={t`Lauf #${id} markieren`}
                        checked={marked.includes(r.id)}
                        disabled={blocked !== null}
                        title={blocked ?? undefined}
                        onChange={() => toggle(r.id)}
                      />
                    </td>
                    <td>
                      <Link to={runPath(r.id)} className="text-accent-700 tabular-nums">
                        #{r.id}
                      </Link>
                      {r.note && <span className="block max-w-48 text-xs">{r.note}</span>}
                    </td>
                    <td className="tabular-nums">
                      {formatDateTime(r.started_at)} · {r.started_by}
                    </td>
                    <td>
                      <span title={names.all}>{names.short}</span>
                      <span className="text-muted block text-xs">{measured(r)}</span>
                    </td>
                    <td>
                      {r.status === 'running' ? (
                        <RunningLabel id={r.id} />
                      ) : (
                        <RunStatusLabel status={r.status} quick={r.scope === 'quick'} />
                      )}
                    </td>
                    <td className="tabular-nums">
                      {rateText(r.reference_rate)}
                      {r.reference_split === 'confirm' && (
                        <span className="text-muted block text-xs">{t`Quote Bestätigung`}</span>
                      )}
                    </td>
                    <td className="tabular-nums">{costText(r, connections)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <p className="text-muted mt-2 text-xs">
            <Trans>
              * Vergleichsbasis = Quote Abstimmung des Basis-Messpunkts (ohne Abstimmungsfälle:
              Quote Bestätigung)
            </Trans>
          </p>
        </>
      )}
    </div>
  )
}
