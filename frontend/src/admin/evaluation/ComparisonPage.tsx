// Two runs side by side (design V6.6, D7): finished runs over the same cases,
// measuring points matched by the server on their whole snapshot (connection,
// model, host, temperature, effort, prompt profile, level, system prompt;
// ``_same_point`` of ``evaluation/run.py``), whose rows this page follows; per
// point both rates on Abstimmung and the difference with its interval and the
// word on Bestätigung. The header says when the layer profile or the data
// differ between the runs. Otherwise ``runs_not_comparable``.
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { Link, useNavigate, useParams } from 'react-router'
import type { PointView, RunComparisonRow, RunView } from '../../api/client'
import { ErrorNotice, Loading } from '../../components/ui'
import { formatNumber } from '../../i18n/locale'
import { useComparison, useRun } from './runs'
import {
  differenceText,
  labelDifferences,
  latencyText,
  moneyText,
  pointName,
  rateText,
  RUNS,
  runPath,
  scopeShort,
  wordText,
} from './runWords'
import { dataStateText } from './words'

/** "#13: System-Prompt geändert bei gpt-6-luna P0" or "… wie im Betrieb". */
function systemPromptNote(run: RunView): string {
  const id = run.id
  const edited = run.points
    .filter((p) => p.label.system_prompt != null)
    .map((p) => pointName(p.label))
  if (!edited.length) return t`#${id}: System-Prompt wie im Betrieb`
  const names = edited.join(', ')
  return t`#${id}: System-Prompt geändert bei ${names}`
}

/** Still falsch, time and cost of one point in both runs ("Details je Messpunkt"). */
function Details({
  rows,
  mine,
  theirs,
}: {
  rows: RunComparisonRow[]
  mine: RunView
  theirs: RunView
}) {
  const a = mine.id
  const b = theirs.id
  const cost = (p: PointView | undefined) => {
    const c = p?.figures?.cost
    return c ? moneyText(c) : '–'
  }
  const silently = (p: PointView | undefined) =>
    p?.figures ? formatNumber(p.figures.silently_wrong) : '–'
  const time = (p: PointView | undefined) =>
    p?.figures
      ? `${latencyText(p.figures.latency_median_ms)} · ${latencyText(p.figures.latency_p90_ms)}`
      : '–'
  return (
    <details className="mt-3 text-sm">
      <summary className="text-muted cursor-pointer">
        <Trans>Details je Messpunkt</Trans>
      </summary>
      <table className="data-table mt-1" aria-label={t`Details je Messpunkt`}>
        <thead>
          <tr>
            <th scope="col">
              <Trans>Messpunkt</Trans>
            </th>
            <th scope="col">{t`still falsch #${a}`}</th>
            <th scope="col">{t`still falsch #${b}`}</th>
            <th scope="col">{t`Zeit Median · oberes Zehntel #${a}`}</th>
            <th scope="col">{t`Zeit Median · oberes Zehntel #${b}`}</th>
            <th scope="col">{t`Kosten #${a}`}</th>
            <th scope="col">{t`Kosten #${b}`}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const left = mine.points[row.point]
            const right = theirs.points[row.point_against]
            return (
              <tr key={i}>
                <th scope="row" className="border-divider font-normal">
                  {pointName(row.label)}
                </th>
                <td className="tabular-nums">{silently(left)}</td>
                <td className="tabular-nums">{silently(right)}</td>
                <td className="tabular-nums whitespace-nowrap">{time(left)}</td>
                <td className="tabular-nums whitespace-nowrap">{time(right)}</td>
                <td className="tabular-nums">{cost(left)}</td>
                <td className="tabular-nums">{cost(right)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </details>
  )
}

export function ComparisonPage() {
  const params = useParams()
  const run = Number(params.id)
  const against = Number(params.other)
  const navigate = useNavigate()
  const comparison = useComparison(run, against)
  const mine = useRun(run).data
  const theirs = useRun(against).data
  const data = comparison.data
  const cases = mine?.label.cases ?? 0
  const state = mine ? dataStateText(mine.label.data_state) : ''
  const both = mine && theirs && mine.label.scope === theirs.label.scope
  const scope = mine ? scopeShort(mine.label.scope) : ''
  const scopes = both ? t`beide ${scope}` : ''
  const shown = comparison.data?.points.length ?? 0
  const left = mine && theirs ? mine.points.length + theirs.points.length - 2 * shown : 0
  const differs = mine && theirs ? labelDifferences(mine, theirs) : []
  return (
    <div className="max-w-5xl">
      <p className="text-muted mb-1 text-sm">
        <Link to={RUNS} className="hover:text-accent-700">
          <Trans>Bewertung › Läufe</Trans>
        </Link>{' '}
        ›
      </p>
      <div className="mb-1 flex items-center gap-2">
        <h2 className="text-2xl">
          <Trans>
            Lauf #{run} gegen Lauf #{against}
          </Trans>
        </h2>
        <button
          type="button"
          className="btn ml-auto"
          onClick={() => navigate(`${runPath(against)}/gegen/${run}`)}
        >
          <Trans>Tauschen</Trans>
        </button>
        <Link to={runPath(run)} className="btn">
          <Trans>Schliessen</Trans>
        </Link>
      </div>
      {mine && (
        <p className="text-muted mb-3 text-sm">
          {[t`Gleiche ${cases} Fälle`, state, scopes].filter(Boolean).join(' · ')}
          {theirs && ` · ${systemPromptNote(mine)} · ${systemPromptNote(theirs)}`}
        </p>
      )}
      {differs.length > 0 && (
        <p className="card border-ink mb-3 p-2 text-sm">
          <strong>{differs.join(' · ')}:</strong>{' '}
          <Trans>
            Die beiden Läufe haben dieselben Fälle, aber nicht denselben Layer-Steckbrief oder
            Datenstand. Ein Unterschied kann auch daher kommen.
          </Trans>
        </p>
      )}
      {comparison.data && left > 0 && (
        <p className="text-muted mb-2 text-xs">
          {t`${left} Messpunkte kommen nur in einem der Läufe vor (andere Anbindung oder anders eingestellt, anderes Promptprofil, andere Stufe oder anderer System-Prompt) und fehlen hier.`}
        </p>
      )}
      {comparison.isPending && <Loading />}
      <ErrorNotice error={comparison.error} />
      {data && data.points.length === 0 && (
        <p className="text-sm">
          <Trans>
            Die beiden Läufe haben keinen gleichen Messpunkt (gleiche Anbindung mit gleicher
            Einstellung, Promptprofil, Stufe und System-Prompt).
          </Trans>
        </p>
      )}
      {data && data.points.length > 0 && (
        <>
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">
                  <Trans>Messpunkt</Trans>
                </th>
                <th scope="col">#{run}</th>
                <th scope="col">#{against}</th>
                <th scope="col">
                  <Trans>Unterschied</Trans>
                </th>
                <th scope="col">
                  <Trans>Aussage</Trans>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.points.map((row, i) => (
                <tr key={i}>
                  <th scope="row" className="border-divider font-normal">
                    {pointName(row.label)}
                  </th>
                  <td className="tabular-nums">{rateText(row.rate)}</td>
                  <td className="tabular-nums">{rateText(row.rate_against)}</td>
                  <td className="tabular-nums">
                    {row.comparison ? differenceText(row.comparison) : '–'}
                  </td>
                  <td>
                    {row.comparison ? (
                      row.comparison.word === 'not_proven' ? (
                        wordText(row.comparison.word)
                      ) : (
                        <strong>{wordText(row.comparison.word)}</strong>
                      )
                    ) : (
                      <span className="text-muted">{t`ohne Aussage`}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-muted mt-2 text-xs">
            <Trans>
              Je Messpunkt: Quote Abstimmung beider Läufe; Unterschied und Spanne auf Bestätigung,
              gepaart je Fall. Eine Aussage nur, wenn beide Läufe vollständig sind (kein
              Schnelltest).
            </Trans>
          </p>
          {mine && theirs && <Details rows={data.points} mine={mine} theirs={theirs} />}
        </>
      )}
    </div>
  )
}
