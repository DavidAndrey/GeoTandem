// Bewertung › Läufe (design V5): the runs with what they measured, their
// status in the language of E2, the reference column's rate and the cost; two
// complete runs over the same cases can be put side by side (D7). Empty: the
// smallest sensible first run (V5.2).
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { useId, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import type { ConnectionInfo, RunStatus, RunSummary } from '../../api/client'
import { useConnections } from '../../api/queries'
import { ErrorNotice, Loading } from '../../components/ui'
import { formatDateTime } from '../format'
import { statusText } from '../../model/statusKey'
import { useRun, useRuns } from './runs'
import {
  comparable,
  NEW_RUN,
  runPath,
  moniesText,
  progressPercent,
  rateText,
  runStatusKey,
  scopeShort,
} from './runWords'
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
  const line = RUN_LINE[status]
  return (
    <span
      role={live ? (status === 'failed' ? 'alert' : 'status') : undefined}
      data-status={status}
      data-line={line}
      className={`inline-flex items-center gap-1 rounded-full border px-2 text-xs whitespace-nowrap ${LINE_CLASS[line]}`}
    >
      <span>{statusText(runStatusKey(status))}</span>
      {detail && <span className="tabular-nums">{detail}</span>}
    </span>
  )
}

/**
 * The status language of E2 for a run (design V5): running dashed, done solid,
 * aborted and interrupted grey with the label struck through, failed black.
 */
const RUN_LINE: Record<RunStatus, 'dashed' | 'solid' | 'void' | 'message'> = {
  running: 'dashed',
  done: 'solid',
  aborted: 'void',
  interrupted: 'void',
  failed: 'message',
}
const LINE_CLASS = {
  dashed: 'border-dashed border-accent text-accent-700',
  solid: 'border-accent text-accent-700',
  void: 'border-neutral-400 text-muted line-through',
  message: 'border-ink text-ink',
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
  const reason =
    chosen.length === 2
      ? comparable(chosen[0], chosen[1])
      : t`Zwei vollständige Läufe mit gleichen Fällen markieren.`
  const toggle = (id: number) =>
    setMarked((m) => (m.includes(id) ? m.filter((x) => x !== id) : [...m.slice(-1), id]))
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
              disabled={chosen.length !== 2 || reason !== null}
              aria-describedby={why}
              onClick={() =>
                chosen.length === 2 && navigate(`${runPath(chosen[0].id)}/gegen/${chosen[1].id}`)
              }
            >
              <Trans>Gegenüberstellen</Trans>
            </button>
            <span className="text-muted ml-auto text-xs">
              <Trans>Vergleichsbasis = Quote Abstimmung des Basis-Messpunkts</Trans>
            </span>
            <Link to={NEW_RUN} className="btn btn-primary">
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
                  <Trans>Messpunkte · Fälle · Datenstand · Umfang</Trans>
                </th>
                <th scope="col">
                  <Trans>Status</Trans>
                </th>
                <th scope="col">
                  <Trans>Vergleichsbasis</Trans>
                </th>
                <th scope="col">
                  <Trans>Kosten</Trans>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => {
                const id = r.id
                return (
                  <tr key={r.id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={t`Lauf #${id} markieren`}
                        checked={marked.includes(r.id)}
                        onChange={() => toggle(r.id)}
                      />
                    </td>
                    <td>
                      <Link to={runPath(r.id)} className="text-accent-700 tabular-nums">
                        #{r.id}
                      </Link>
                    </td>
                    <td className="tabular-nums">
                      {formatDateTime(r.started_at)} · {r.started_by}
                    </td>
                    <td>{measured(r)}</td>
                    <td>
                      {r.status === 'running' ? (
                        <RunningLabel id={r.id} />
                      ) : (
                        <RunStatusLabel status={r.status} quick={r.scope === 'quick'} />
                      )}
                    </td>
                    <td className="tabular-nums">{rateText(r.reference_rate)}</td>
                    <td className="tabular-nums">{costText(r, connections)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <p id={why} className="text-muted mt-2 text-xs">
            {reason ?? t`Bereit zum Gegenüberstellen.`}
          </p>
        </>
      )}
    </div>
  )
}
