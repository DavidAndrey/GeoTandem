// A case in a run (design V7): the question and the reference left, the
// repeats right (1.1-2.5: verdict, explanation, assumptions, time). An opened
// answer shows the stage-1 difference in words (+ − ~, D5), both result sets as
// counts and the differing objects (V7.2), also for a right answer worded
// otherwise (V7.3); a refused or unreadable answer its code in words and the
// raw text under "Technisch" (V7.4); a behaviour case expected against given
// (V7.5). Answer and reference open in the workplace.
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { Fragment, useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import type { AnswerView, EvalCase, RunView } from '../../api/client'
import { useLayers } from '../../api/queries'
import { ErrorNotice, Loading } from '../../components/ui'
import { labelsFor } from '../../editor/fields'
import { formatNumber } from '../../i18n/locale'
import { ChangeLines } from '../../model/approval/Approval'
import { technical } from '../../model/panel/problems'
import { catalogLayer } from '../../model/approval/changes'
import { StatusLabel } from '../../model/status'
import { compactQuery } from '../../model/readable'
import { partOf } from './reference'
import { useOpenInWorkplace } from './openInWorkplace'
import { Reference } from './Reference'
import { useAnswers, useRun } from './runs'
import { VerdictLabel } from './runParts'
import {
  answerCodeText,
  casePath,
  pointName,
  RUNS,
  runPath,
  diffChange,
  givenKind,
  idsText,
  isSilentlyWrong,
  latencyText,
  repeatNames,
} from './runWords'
import { isBehaviour, kindText, readingName, readings } from './words'

type Words = ReturnType<typeof labelsFor>

const queryOf = (a: AnswerView): Record<string, unknown> | null =>
  a.answer?.kind === 'query' ? a.answer.query : null

function explanationOf(a: AnswerView): string {
  const answer = a.answer
  if (!answer) return '–'
  if (answer.kind === 'clarification') return answer.question
  return answer.explanation
}

function assumptionsOf(a: AnswerView): string {
  const answer = a.answer
  if (answer?.kind !== 'query' && answer?.kind !== 'plan') return '–'
  if (!answer.assumptions?.length) return t`keine`
  return answer.assumptions.map((x) => x.text).join('; ')
}

function Technical({ answer }: { answer: AnswerView }) {
  return (
    <details className="text-xs">
      <summary className="text-muted cursor-pointer">
        <Trans>Technisch (Antwort JSON · Rohtext)</Trans>
      </summary>
      {answer.code && (
        <pre className="mt-1 font-mono whitespace-pre-wrap">
          {technical(answer.code, answer.refusal?.details ?? {})}
        </pre>
      )}
      {answer.answer && (
        <pre className="mt-1 overflow-auto bg-neutral-200 p-2 font-mono whitespace-pre-wrap">
          {JSON.stringify(compactQuery(answer.answer), null, 2)}
        </pre>
      )}
      {answer.raw && (
        <pre className="mt-1 overflow-auto bg-neutral-200 p-2 font-mono whitespace-pre-wrap">
          {answer.raw}
        </pre>
      )}
    </details>
  )
}

/** The stage-1 difference, both result sets and the differing objects (V7.2, V7.3). */
function Difference({ answer, words }: { answer: AnswerView; words: Words }) {
  const changes = (answer.diff ?? []).map((entry) => diffChange(entry, words))
  const reference = answer.reference_hits
  const hits = answer.hits
  const onlyAnswer = formatNumber(answer.only_answer_count)
  const onlyReference = formatNumber(answer.only_reference_count)
  const answerIds = idsText(answer.only_answer, answer.only_answer_count)
  const referenceIds = idsText(answer.only_reference, answer.only_reference_count)
  return (
    <div className="flex flex-col gap-1 text-sm">
      {answer.diff && (
        <div className="bg-neutral-200 p-2">
          {changes.length ? (
            <ChangeLines changes={changes} />
          ) : (
            <p className="text-xs">
              <Trans>Nach Stufe 1 dieselbe Abfrage wie die Referenz.</Trans>
            </p>
          )}
        </div>
      )}
      {reference != null && hits != null && (
        <p className="tabular-nums">
          <Trans>
            Referenz <strong>{reference}</strong> · Antwort <strong>{hits}</strong> · nur in Antwort{' '}
            <strong>{onlyAnswer}</strong> · nur in Referenz <strong>{onlyReference}</strong>
          </Trans>
        </p>
      )}
      {answer.only_answer_count > 0 && (
        <p className="text-muted text-xs">{t`Nur in Antwort: ${answerIds}`}</p>
      )}
      {answer.only_reference_count > 0 && (
        <p className="text-muted text-xs">{t`Nur in Referenz: ${referenceIds}`}</p>
      )}
    </div>
  )
}

function AnswerDetail({
  answer,
  name,
  c,
  words,
  dataStateDocs,
}: {
  answer: AnswerView
  name: string
  c: EvalCase
  words: Words
  dataStateDocs: Record<string, unknown>[]
}) {
  const catalog = useLayers().data
  const { open, dialog } = useOpenInWorkplace()
  const query = queryOf(answer)
  const answerPart = useMemo(() => (query ? partOf(query, catalog) : null), [query, catalog])
  const reading = answer.reading ?? 0
  const referenceDoc = dataStateDocs[reading]
  const referencePart = useMemo(
    () => (referenceDoc ? partOf(referenceDoc, catalog) : null),
    [referenceDoc, catalog],
  )
  const several = dataStateDocs.length > 1
  const which = several ? readingName(reading) : t`Referenz`
  const flags = answer.flags ?? []
  const behaviour = isBehaviour(c)
  const v = answer.verdict
  const given = givenKind(answer)
  let heading = t`Antwort ${name}`
  if (answer.diff) heading = t`Antwort ${name} · Unterschied zur ${which}`
  return (
    <div className="card border-ink my-1 flex flex-col gap-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="label-caps">{heading}</p>
        {query && (
          <span className="ml-auto flex gap-2">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!answerPart}
              onClick={() => answerPart && open(answerPart, true)}
            >
              <Trans>Antwort im Arbeitsplatz</Trans>
            </button>
            {referenceDoc && (
              <button
                type="button"
                className="btn"
                disabled={!referencePart}
                onClick={() => referencePart && open(referencePart)}
              >
                <Trans>Referenz im Arbeitsplatz</Trans>
              </button>
            )}
          </span>
        )}
      </div>
      {v === 'refused' && (
        <div role="alert" className="flex flex-col gap-1 text-sm">
          <StatusLabel status="refused" detail={t`· nicht anwendbar`} />
          <p>{answerCodeText(answer)}</p>
        </div>
      )}
      {v === 'error' && (
        <div role="alert" className="flex flex-col gap-1 text-sm">
          <p className="font-semibold">
            <Trans>Antwort nicht lesbar</Trans>
          </p>
          <p>{answerCodeText(answer)}</p>
        </div>
      )}
      {behaviour && (
        <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
          <dt className="label-caps">
            <Trans>Erwartet</Trans>
          </dt>
          <dd>
            {c.expect && kindText(c.expect)}
            {c.also.length > 0 &&
              ` · ${t`auch zulässig:`} ${c.also.map((k) => kindText(k)).join(', ')}`}
          </dd>
          <dt className="label-caps">
            <Trans>Gegeben</Trans>
          </dt>
          <dd>
            {givenKind(answer)}
            {answer.answer && ` · ${explanationOf(answer)}`}
          </dd>
        </dl>
      )}
      {(v === 'kind' || v === 'other_approach' || v === 'forbidden') && !behaviour && (
        <p className="text-sm">{t`Gegeben: ${given}`}</p>
      )}
      {v === 'other_approach' && (
        <p className="text-sm">
          <Trans>Das Modell bot eine andere Arbeitsweise an, wo der Fall keine erwartet.</Trans>
        </p>
      )}
      {v === 'forbidden' && (
        <p className="text-sm">
          <Trans>Die Antwort enthält, was der Fall ausdrücklich ausschliesst.</Trans>
        </p>
      )}
      {(answer.diff || answer.hits != null) && <Difference answer={answer} words={words} />}
      {v === 'pass' && (answer.diff?.length ?? 0) > 0 && (
        <p className="text-muted text-xs">
          <Trans>
            Stufe 1 erklärt den Unterschied, sie urteilt nicht: gleiche Ergebnismenge = richtig.
          </Trans>
        </p>
      )}
      {isSilentlyWrong(answer) && (
        <p className="text-sm">
          <Trans>
            <strong>Keine Annahme genannt</strong>, obwohl die Abfrage nicht der Referenz
            entspricht: still falsch.
          </Trans>
        </p>
      )}
      {flags.includes('zero_hits') && (
        <p className="text-sm">
          <Trans>Die Abfrage der Antwort liefert keine Treffer.</Trans>
        </p>
      )}
      <Technical answer={answer} />
      {dialog}
    </div>
  )
}

function Neighbours({ run, caseId, point }: { run: RunView; caseId: string; point: number }) {
  const ids = run.cases
    .filter((rc) => rc.status !== 'stale' && rc.status !== 'invalid')
    .map((rc) => rc.case.id)
  const at = ids.indexOf(caseId)
  const prev = at > 0 ? ids[at - 1] : null
  const next = at >= 0 && at < ids.length - 1 ? ids[at + 1] : null
  const points = run.points.length
  const link = 'hover:text-accent-700 px-1'
  const off = 'text-muted px-1 opacity-50'
  return (
    <nav aria-label={t`Weitere Zellen`} className="ml-auto flex items-center gap-1 text-sm">
      {prev ? (
        <Link to={casePath(run.id, prev, point)} className={link} aria-label={t`Voriger Fall`}>
          ‹
        </Link>
      ) : (
        <span className={off}>‹</span>
      )}
      <Trans>Fall</Trans>
      {next ? (
        <Link to={casePath(run.id, next, point)} className={link} aria-label={t`Nächster Fall`}>
          ›
        </Link>
      ) : (
        <span className={off}>›</span>
      )}
      <span aria-hidden>·</span>
      {point > 0 ? (
        <Link
          to={casePath(run.id, caseId, point - 1)}
          className={link}
          aria-label={t`Voriger Messpunkt`}
        >
          ‹
        </Link>
      ) : (
        <span className={off}>‹</span>
      )}
      <Trans>Messpunkt</Trans>
      {point < points - 1 ? (
        <Link
          to={casePath(run.id, caseId, point + 1)}
          className={link}
          aria-label={t`Nächster Messpunkt`}
        >
          ›
        </Link>
      ) : (
        <span className={off}>›</span>
      )}
    </nav>
  )
}

function Answers({
  answers,
  c,
  words,
  docs,
}: {
  answers: AnswerView[]
  c: EvalCase
  words: Words
  docs: Record<string, unknown>[]
}) {
  const [opened, setOpened] = useState<number | null>(null)
  const names = repeatNames(answers)
  const sorted = [...answers].sort((a, b) => a.block - b.block || a.seed - b.seed)
  const right = sorted.filter((a) => a.verdict === 'pass').length
  const wrong = sorted.filter((a) => a.verdict === 'wrong').length
  const silent = sorted.filter(isSilentlyWrong).length
  const rightCount = formatNumber(right)
  const wrongCount = formatNumber(wrong)
  const summary =
    wrong > 0 && silent === wrong
      ? t`Antworten · ${rightCount} richtig · ${wrongCount} falsch, alle still`
      : t`Antworten · ${rightCount} richtig · ${wrongCount} falsch`
  return (
    <section aria-label={t`Antworten`} className="min-w-0">
      <p className="label-caps mb-1">{summary}</p>
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">
              <Trans>Urteil</Trans>
            </th>
            <th scope="col">
              <Trans>Erklärung des Modells</Trans>
            </th>
            <th scope="col">
              <Trans>Annahmen</Trans>
            </th>
            <th scope="col">
              <Trans>Zeit</Trans>
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((a, i) => {
            const name = names.get(a) ?? ''
            const open = opened === i
            const detail = `answer-detail-${i}`
            return (
              <Fragment key={`${a.block}-${a.seed}`}>
                <tr className={open ? 'bg-neutral-200' : ''}>
                  <th scope="row" className="border-divider font-normal">
                    <button
                      type="button"
                      className="hover:text-accent-700 tabular-nums"
                      aria-expanded={open}
                      aria-controls={open ? detail : undefined}
                      aria-label={t`Antwort ${name}`}
                      onClick={() => setOpened(open ? null : i)}
                    >
                      {name}
                    </button>
                  </th>
                  <td>
                    <VerdictLabel answer={a} />
                  </td>
                  <td>{explanationOf(a)}</td>
                  <td>{assumptionsOf(a)}</td>
                  <td className="tabular-nums whitespace-nowrap">{latencyText(a.latency_ms)}</td>
                </tr>
                {open && (
                  <tr id={detail}>
                    <td colSpan={5}>
                      <AnswerDetail
                        answer={a}
                        name={name}
                        c={c}
                        words={words}
                        dataStateDocs={docs}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </section>
  )
}

function CaseInRun({ run, caseId, point }: { run: RunView; caseId: string; point: number }) {
  const rc = run.cases.find((x) => x.case.id === caseId)
  const view = run.points[point]
  const answers = useAnswers(run.id, caseId, point, rc !== undefined && view !== undefined)
  const catalog = useLayers().data
  const c = rc?.case
  const docs = useMemo(() => (c ? readings(c) : []), [c])
  const source = typeof docs[0]?.source === 'string' ? docs[0].source : undefined
  const words = useMemo(
    () => labelsFor(source ? catalogLayer(source) : undefined, catalog),
    [source, catalog],
  )
  if (!rc || !c || !view)
    return (
      <p role="alert" className="text-sm">
        <Trans>Diesen Fall oder Messpunkt gibt es in diesem Lauf nicht.</Trans>
      </p>
    )
  const id = run.id
  const name = pointName(view.label)
  // Per reading the hits an answer measured against it; a reading no answer used stays open.
  const hits: number[] = []
  docs.forEach((_, i) => {
    const found = answers.data?.find((a) => a.reading === i && a.reference_hits != null)
    if (found?.reference_hits != null) hits[i] = found.reference_hits
  })
  return (
    <div className="max-w-7xl">
      <p className="text-muted mb-1 text-sm">
        <Link to={RUNS} className="hover:text-accent-700">
          <Trans>Bewertung › Läufe</Trans>
        </Link>{' '}
        ›{' '}
        <Link to={runPath(run.id)} className="hover:text-accent-700">
          <Trans>Lauf #{id}</Trans>
        </Link>{' '}
        ›
      </p>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="text-2xl">
          <Trans>
            Lauf #{id} › <code className="font-mono text-xl">{caseId}</code> › {name}
          </Trans>
        </h2>
        <Neighbours run={run} caseId={caseId} point={point} />
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <section aria-label={t`Prüffall`} className="flex flex-col gap-2">
          <p className="label-caps">
            <Trans>Frage</Trans>
          </p>
          <p className="text-lg">{c.prompt}</p>
          {isBehaviour(c) ? (
            <>
              <p className="label-caps">
                <Trans>Erwartet</Trans>
              </p>
              <p>{c.expect && kindText(c.expect)}</p>
              {c.also.length > 0 && (
                <p className="text-sm">
                  {t`auch zulässig:`} {c.also.map((k) => kindText(k)).join(', ')}
                </p>
              )}
              <p className="text-muted text-sm">
                <Trans>Verhaltensfall</Trans>
              </p>
            </>
          ) : docs.length > 0 ? (
            <>
              <p className="label-caps">
                <Trans>Referenz</Trans>
              </p>
              <Reference docs={docs} hits={hits} dataState={run.label.data_state} />
            </>
          ) : null}
        </section>
        <div>
          {answers.isPending && <Loading />}
          <ErrorNotice error={answers.error} />
          {answers.data && answers.data.length === 0 && (
            <p className="text-muted text-sm">
              <Trans>Noch keine Antwort für diese Zelle.</Trans>
            </p>
          )}
          {answers.data && answers.data.length > 0 && (
            <Answers answers={answers.data} c={c} words={words} docs={docs} />
          )}
        </div>
      </div>
    </div>
  )
}

export function RunCasePage() {
  const params = useParams()
  const [search] = useSearchParams()
  const run = useRun(Number(params.id))
  const point = Number(search.get('punkt') ?? 0)
  if (run.error) return <ErrorNotice error={run.error} />
  if (!run.data) return <Loading />
  return <CaseInRun run={run.data} caseId={params.fall ?? ''} point={point} />
}
