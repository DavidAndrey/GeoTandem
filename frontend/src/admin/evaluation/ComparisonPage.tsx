// Two runs side by side (design V6.6, D7): complete runs over the same cases,
// measuring points matched by connection, prompt profile, level and system
// prompt; per point both rates on Abstimmung and the difference with its
// interval and the word on Bestätigung. Otherwise ``runs_not_comparable``.
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { Link, useNavigate, useParams } from 'react-router'
import { ErrorNotice, Loading } from '../../components/ui'
import { useComparison, useRun } from './runs'
import {
  differenceText,
  pointName,
  rateText,
  RUNS,
  runPath,
  scopeShort,
  wordText,
} from './runWords'
import { dataStateText } from './words'

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
        </p>
      )}
      {comparison.isPending && <Loading />}
      <ErrorNotice error={comparison.error} />
      {data && data.points.length === 0 && (
        <p className="text-sm">
          <Trans>
            Die beiden Läufe haben keinen gleichen Messpunkt (gleiche Anbindung, Promptprofil, Stufe
            und System-Prompt).
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
        </>
      )}
    </div>
  )
}
