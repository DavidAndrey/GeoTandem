// A run (design V6): the matrix of cases × measuring points (F-3.18). While
// it runs (V6.1) the progress, the time, the cost so far and abort; cells fill
// in, column heads come only at the end (design review 5). Done (V6.2): rows
// grouped by tag with group sums, a column head per point with the figures of
// plan section 2, the rate on Abstimmung and the comparison words on
// Bestätigung (design review 1); "still falsch" as dashed frame, "!" and text
// (review 2). The run's label (V6.3), "Promptprofil übernehmen" (V6.4), the
// quick test without comparison (V6.5), export, "Zur Anbindung" (review 6).
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { DropdownMenu } from 'radix-ui'
import { useEffect, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router'
import {
  api,
  type Cell,
  type ConnectionInfo,
  type PointView,
  type RunView,
  type Split,
} from '../../api/client'
import { useConnections } from '../../api/queries'
import { ConfirmDialog, ErrorNotice, Loading, Modal } from '../../components/ui'
import { errorText } from '../../i18n/errors'
import { formatNumber } from '../../i18n/locale'
import { formatDateTime, percent } from '../format'
import { ProfileCompleteness } from '../ProfileCompleteness'
import { examplesLabel, outputLabel, sameProfile } from '../promptProfile'
import {
  applyProfile,
  connectionProfile,
  isOwnProfile,
  placementText,
  profileText,
} from './profileOptions'
import { runKeys, useRun, useRuns } from './runs'
import { RunStatusLabel } from './RunsPage'
import { Choice, StillWrong } from './runParts'
import {
  casePath,
  cellKey,
  cellMap,
  clock,
  NEW_RUN,
  pointName,
  pointSub,
  RUNS,
  runPath,
  differenceText,
  durationText,
  groupCases,
  groupTitle,
  latencyText,
  legendText,
  mixText,
  moneyText,
  moniesText,
  ofText,
  progressPercent,
  rateText,
  remainingSeconds,
  repeats,
  runErrorText,
  scopeText,
  silentlyText,
  sumCells,
  tokensText,
  wordText,
  type Group,
} from './runWords'
import { dataStateText, splitText } from './words'

/** Rows of a group shown before "▸ n weitere". */
const SHOWN = 2

// --- column heads -------------------------------------------------------------------

function PointHead({ view, index, run }: { view: PointView; index: number; run: RunView }) {
  const label = view.label
  const f = view.figures
  const reference = index === run.reference
  const quick = run.label.scope === 'quick'
  const tuning = f?.by_split.tuning
  const c = view.comparison
  const silently = f?.silently_wrong ?? 0
  const unreadable = f?.unreadable ?? 0
  const behaviour = f ? ofText(f.behaviour_met, f.behaviour_answers) : ''
  const limited = f?.limited ?? 0
  const tokens = f ? tokensText(f.prompt_tokens + f.completion_tokens) : ''
  return (
    <th
      scope="col"
      data-reference={reference || undefined}
      className={`align-bottom font-normal ${reference ? 'shadow-[inset_0_3px_0_var(--color-ink)]' : ''}`}
    >
      <span className="block font-semibold">{label.connection_name}</span>
      <span className="text-muted block font-mono text-xs">{pointSub(label)}</span>
      {run.status === 'running' && (
        <span className="text-muted block text-xs">
          <Trans>läuft …</Trans>
        </span>
      )}
      {f && (
        <span className="mt-1 block text-xs">
          <span className="block">
            <span className="text-lg tabular-nums">{rateText(f.rate_tuning)}</span>{' '}
            {tuning && (
              <span className="tabular-nums">{ofText(tuning.passed, tuning.answers)}</span>
            )}
            <span className="sr-only"> {t`Quote Abstimmung`}</span>
          </span>
          <span className="block tabular-nums">
            {t`still falsch ${silently} · nicht lesbar ${unreadable}`}
          </span>
          {f.behaviour_answers > 0 && (
            <span className="block tabular-nums">{t`Verhalten ${behaviour}`}</span>
          )}
          {Object.keys(f.errors ?? {}).length > 0 && (
            <span className="text-muted block font-mono">
              {Object.entries(f.errors ?? {}).map(([code, n], i) => (
                <span key={code} title={errorText(code)}>
                  {i > 0 && ' · '}
                  {code} {formatNumber(n)}
                  <span className="sr-only"> ({errorText(code)})</span>
                </span>
              ))}
            </span>
          )}
          {f.limited > 0 && (
            <span className="block tabular-nums">{t`an einer Grenze ${limited}`}</span>
          )}
          <span className="text-muted block tabular-nums">
            {latencyText(f.latency_median_ms)} · {latencyText(f.latency_p90_ms)} ·{' '}
            {f.cost ? moneyText(f.cost) : label.locality === 'local' ? t`lokal` : t`kein Preis`} ·{' '}
            {t`${tokens} Tokens`}
          </span>
          <span className="mt-1 block">
            {reference ? (
              <span className="border-ink inline-block rounded-full border px-2">
                <Trans>Vergleichsbasis</Trans>
              </span>
            ) : quick ? (
              <span className="text-muted">{t`Vergleich: –`}</span>
            ) : c ? (
              <>
                <strong>{wordText(c.word)}</strong> · {differenceText(c)}
              </>
            ) : (
              <span className="text-muted">{t`Vergleich: keine Bestätigungsfälle`}</span>
            )}
          </span>
        </span>
      )}
    </th>
  )
}

// --- cells --------------------------------------------------------------------------

function CellView({
  cell,
  run,
  caseId,
  question,
  point,
  split,
}: {
  cell: Cell | undefined
  run: RunView
  caseId: string
  question: string
  point: PointView
  split: Split
}) {
  const expected = repeats(run.label.scope)
  if (!cell || cell.answers === 0)
    return <span className="text-muted">{run.status === 'running' ? '·' : '–'}</span>
  const name = pointName(point.label)
  const mix = mixText(cell)
  const unfinished = run.status === 'running' && cell.answers < expected
  const answers = formatNumber(cell.answers)
  return (
    <Link
      to={casePath(run.id, caseId, cell.point, split)}
      className={`hover:text-accent-700 block tabular-nums whitespace-nowrap ${cell.silently_wrong ? 'border-ink border border-dashed p-0.5' : ''}`}
    >
      <span className="sr-only">{t`${question} bei ${name}:`}</span>{' '}
      <strong>{formatNumber(cell.passed)}</strong>{' '}
      <span className="text-muted">
        {t`von ${answers}`}
        {mix && ` · ${mix}`}
        {unfinished && ` · ${t`läuft`}`}
      </span>
      {cell.silently_wrong > 0 && (
        <span className="block">
          <StillWrong>{silentlyText(cell.silently_wrong)}</StillWrong>
        </span>
      )}
    </Link>
  )
}

function GroupRows({
  group,
  run,
  cells,
  split,
}: {
  group: Group
  run: RunView
  cells: Map<string, Cell>
  split: Split
}) {
  const [open, setOpen] = useState(false)
  const ids = new Set(group.cases.map((rc) => rc.case.id))
  const shown = open ? group.cases : group.cases.slice(0, SHOWN)
  const more = group.cases.length - SHOWN
  const done = run.status === 'done'
  return (
    <tbody>
      <tr className="bg-neutral-200">
        <th scope="rowgroup" className="border-divider font-semibold">
          {groupTitle(group)}
        </th>
        {run.points.map((_, point) => {
          const sum = sumCells(run.cells, ids, point)
          return (
            <td key={point} className="font-semibold tabular-nums">
              {sum.answers ? ofText(sum.passed, sum.answers) : done ? '–' : ''}
            </td>
          )
        })}
      </tr>
      {shown.map((rc) => (
        <tr key={rc.case.id}>
          <th scope="row" className="border-divider font-normal">
            <span className="block">{rc.case.prompt}</span>
            <code className="text-muted text-xs">{rc.case.id}</code>
            {rc.status === 'dataset_changed' && (
              <span className="ml-1 text-xs">
                <Trans>· Datenstand geändert</Trans>
              </span>
            )}
          </th>
          {run.points.map((p, point) => (
            <td key={point}>
              <CellView
                cell={cells.get(cellKey(rc.case.id, point))}
                run={run}
                caseId={rc.case.id}
                question={rc.case.prompt}
                point={p}
                split={split}
              />
            </td>
          ))}
        </tr>
      ))}
      {more > 0 && (
        <tr>
          <td colSpan={run.points.length + 1}>
            <button
              type="button"
              className="text-muted hover:text-accent-700 text-xs"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
            >
              {open ? t`▾ weniger` : t`▸ ${more} weitere`}
            </button>
          </td>
        </tr>
      )}
    </tbody>
  )
}

function Matrix({ run, split }: { run: RunView; split: Split }) {
  const groups = groupCases(run.cases, split)
  const cells = cellMap(run.cells)
  return (
    <div className="overflow-x-auto">
      <table className="data-table" aria-label={t`Matrix: Prüffälle × Messpunkte`}>
        <thead>
          <tr>
            <th scope="col" className="align-bottom">
              <Trans>Prüffall</Trans>
              <span className="text-muted block text-xs font-normal">
                <Trans>gruppiert nach erstem Stichwort</Trans>
              </span>
            </th>
            {run.points.map((p, i) => (
              <PointHead key={i} view={p} index={i} run={run} />
            ))}
          </tr>
        </thead>
        {groups.map((g) => (
          <GroupRows key={g.key} group={g} run={run} cells={cells} split={split} />
        ))}
      </table>
      {groups.length === 0 && (
        <p className="text-muted text-sm">
          <Trans>Keine Prüffälle in diesem Teil.</Trans>
        </p>
      )}
    </div>
  )
}

// --- running ------------------------------------------------------------------------

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 10_000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

function Progress({ run }: { run: RunView }) {
  const [asking, setAsking] = useState(false)
  const client = useQueryClient()
  const abort = useMutation({
    mutationFn: () => api.evaluation.abort(run.id),
    onSuccess: (view) => {
      client.setQueryData(runKeys.one(run.id), view)
      void client.invalidateQueries({ queryKey: runKeys.list })
      setAsking(false)
    },
  })
  const now = useNow(true)
  const done = formatNumber(run.progress.done)
  const total = formatNumber(run.progress.total)
  const share = progressPercent(run.progress.done, run.progress.total)
  const step = Math.floor(share / 10) * 10
  const since = clock(run.label.started_at)
  const left = remainingSeconds(run.label.started_at, run.progress.done, run.progress.total, now)
  const cost = moniesText(run.cost_so_far)
  const remaining = left !== null ? durationText(left) : ''
  const id = run.id
  return (
    <div className="card mb-3 p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <p className="tabular-nums">
          <strong>{t`${done} von ${total} Antworten`}</strong> · {share} % · {t`seit ${since}`}
          {left !== null && ` · ${t`noch ${remaining}`}`}
          {cost && ` · ${t`bisher ${cost}`}`}
        </p>
        <button type="button" className="btn ml-auto" onClick={() => setAsking(true)}>
          <Trans>Abbrechen</Trans>
        </button>
      </div>
      {/* Announced in steps of a tenth, not at every answer; the end by the status label. */}
      <p role="status" className="sr-only">
        {t`${step} % der Antworten`}
      </p>
      <div aria-hidden className="mt-2 h-1 w-full bg-neutral-300">
        <div className="bg-accent h-full" style={{ width: `${share}%` }} />
      </div>
      <p className="text-muted mt-1 text-xs">
        <Trans>
          Läuft weiter, wenn Sie die Seite schliessen. Nach einem Neustart: „unterbrochen“, die
          bisherigen Antworten bleiben.
        </Trans>
      </p>
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={t`Lauf #${id} abbrechen?`}
        confirm={t`Lauf abbrechen`}
        busy={abort.isPending}
        onConfirm={() => abort.mutate()}
      >
        <p>
          <Trans>
            Der Lauf hält vor der nächsten Frage an. Die bisherigen Antworten bleiben; Quoten und
            Vergleich gibt es nur für vollständige Läufe.
          </Trans>
        </p>
        <ErrorNotice error={abort.error} />
      </ConfirmDialog>
    </div>
  )
}

// --- the label (V6.3) ---------------------------------------------------------------

const short = (hash: string) => `#${hash.slice(0, 4)}`

function LabelRow({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[11rem_minmax(0,1fr)] gap-3 py-0.5">
      <dt className="label-caps">{term}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  )
}

/** "Beschriftungen 22 % · Codelisten 100 % · Beschreibungen 15 %" (V8.1 in one line). */
function profileLine(run: RunView): string {
  const p = run.label.profile
  const share = (done: number, whole: number) => {
    const value = percent(done, whole)
    if (value === null) return '–'
    const shown = formatNumber(value)
    return t`${shown} %`
  }
  const labels = share(p.labelled, p.attributes)
  const codes = share(p.text_with_codes, p.text_attributes)
  const described = share(p.described, p.layers + p.attributes)
  return t`Beschriftungen ${labels} · Codelisten ${codes} · Beschreibungen ${described}`
}

function seedsText(seeds: number[]) {
  if (!seeds.length) return '–'
  const first = formatNumber(Math.min(...seeds))
  const last = formatNumber(Math.max(...seeds))
  return t`Seeds ${first}–${last}`
}

function RunLabelView({ run }: { run: RunView }) {
  const l = run.label
  const versions = Object.entries(l.dataset_versions ?? {})
  const schema = l.query_schema
  const grading = l.grading_version
  const cases = l.cases
  const account = l.account
  const when = formatDateTime(l.started_at)
  const by = l.started_by
  return (
    <details className="mb-3 text-sm">
      <summary className="text-muted cursor-pointer">
        <Trans>Beschriftung des Laufs</Trans>
      </summary>
      <dl className="card mt-1 p-3">
        <LabelRow term={t`Schema`}>
          <span className="font-mono text-xs">
            {t`Abfrageschema v${schema} · Bewertungsregeln v${grading}`}
          </span>
        </LabelRow>
        <LabelRow term={t`Datenstand`}>
          {dataStateText(l.data_state)}{' '}
          {l.sample_version && <span className="font-mono text-xs">{l.sample_version}</span>}
          {versions.length > 0 && (
            <span className="block font-mono text-xs">
              {versions.map(([layer, v]) => `${layer} ${v ?? '–'}`).join(' · ')}
            </span>
          )}
        </LabelRow>
        <LabelRow term={t`Steckbrief`}>
          {profileLine(run)}{' '}
          <span className="font-mono text-xs">{short(l.profile.profile_hash)}</span>
          <details className="mt-1">
            <summary className="text-muted cursor-pointer text-xs">
              <Trans>Vollständigkeit im Einzelnen</Trans>
            </summary>
            <ProfileCompleteness summary={l.profile} heading={t`Vollständigkeit beim Lauf`} />
          </details>
        </LabelRow>
        <LabelRow term={t`Fälle`}>
          {t`${cases} Fälle`} · {scopeText(l.scope)} · {seedsText(l.seeds)}{' '}
          <span className="font-mono text-xs">{short(l.case_set_hash)}</span>
        </LabelRow>
        <LabelRow term={t`Konto · gestartet`}>
          {t`Sicht von ${account} · ${when} durch ${by}`}
        </LabelRow>
        {run.points.map((p, i) => {
          const label = p.label
          const level = label.level_name
          const temperature = formatNumber(label.temperature)
          const effort = label.reasoning_effort
          return (
            <LabelRow key={i} term={pointName(label)}>
              <span className="font-mono text-xs">{label.host}</span> · {label.model} ·{' '}
              {t`Temperatur ${temperature}`} · {t`Denkaufwand ${effort}`} ·{' '}
              {profileText(label.prompt_profile)} · {t`Stufe ${level}`} ·{' '}
              {label.system_prompt != null
                ? t`System-Prompt geändert`
                : t`System-Prompt wie im Betrieb`}{' '}
              <span className="font-mono text-xs">{short(label.system_prompt_hash)}</span>
            </LabelRow>
          )
        })}
      </dl>
    </details>
  )
}

// --- Promptprofil übernehmen (V6.4) -------------------------------------------------

function ApplyProfileDialog({
  run,
  index,
  connection,
  onClose,
}: {
  run: RunView
  index: number
  connection: ConnectionInfo | undefined
  onClose: () => void
}) {
  const client = useQueryClient()
  const point = run.points[index]
  const label = point.label
  const now = connectionProfile(connection)
  const next = label.prompt_profile
  const apply = useMutation({
    mutationFn: () => applyProfile(label.connection_id, next),
    onSuccess: () => {
      void client.invalidateQueries()
      onClose()
    },
  })
  const name = label.connection_name
  const host = label.host
  const id = run.id
  const reference = run.points[run.reference]
  const refName = pointName(reference.label)
  const c = point.comparison
  const lines = [
    [t`Platzierung`, placementText(now.placement), placementText(next.placement)],
    [t`Beispiele`, examplesLabel(now.examples), examplesLabel(next.examples)],
    [t`Ausgabe`, outputLabel(now.output), outputLabel(next.output)],
  ]
  const silentlyCount = point.figures?.silently_wrong ?? 0
  const refCount = reference.figures?.silently_wrong ?? 0
  const silently = formatNumber(silentlyCount)
  const refSilently = formatNumber(refCount)
  const word = c ? wordText(c.word) : ''
  const diff = c ? differenceText(c) : ''
  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title={t`Promptprofil übernehmen?`}
      description={t`Setzt das Promptprofil dieses Messpunkts auf der Anbindung im Betrieb.`}
    >
      <p className="mb-2 text-sm">
        <Trans>
          Für die Anbindung <strong>{name}</strong> (<span className="font-mono">{host}</span>) gilt
          im Betrieb ab sofort:
        </Trans>
      </p>
      <ul aria-label={t`Änderungen`} className="mb-2 bg-neutral-200 p-2 font-mono text-xs">
        {lines.map(([part, before, after]) => (
          <li key={part}>
            {before === after
              ? t`${part}: ${after} (unverändert)`
              : `~ ${t`${part}: ${before} → ${after}`}`}
          </li>
        ))}
      </ul>
      {c && (
        <p className="mb-1 text-sm">
          <Trans>
            Gemessen in Lauf #{id}: <strong>{word}</strong> als {refName}, {diff} auf Bestätigung.
          </Trans>
          {silentlyCount > refCount && (
            <>
              {' '}
              <Trans>
                Aber: <strong>{silently} still falsch</strong> gegenüber {refSilently} bei {refName}
                .
              </Trans>
            </>
          )}
        </p>
      )}
      <p className="text-muted mb-3 text-xs">
        <Trans>
          Betrifft alle Anwender dieser Anbindung. System-Prompt und Stufen bleiben unverändert. Im
          Protokoll der Administration vermerkt.
        </Trans>
      </p>
      <ErrorNotice error={apply.error} />
      <div className="flex justify-end gap-2">
        <button type="button" className="btn" onClick={onClose}>
          <Trans>Abbrechen</Trans>
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={apply.isPending || sameProfile(now, next)}
          onClick={() => apply.mutate()}
        >
          <Trans>Übernehmen</Trans>
        </button>
      </div>
    </Modal>
  )
}

function ColumnActions({ run }: { run: RunView }) {
  const connections = useConnections().data
  const [applying, setApplying] = useState<number | null>(null)
  const quick = run.label.scope === 'quick'
  const seen = new Set<number>()
  const linked = run.points.filter((p) => {
    if (seen.has(p.label.connection_id)) return false
    seen.add(p.label.connection_id)
    return true
  })
  const menu = 'card z-[1300] min-w-48 bg-neutral-100 py-1 shadow-[var(--shadow-md)]'
  const item =
    'block cursor-pointer px-3 py-1 text-sm outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-neutral-200'
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
      <span className="label-caps">
        <Trans>Je Spalte</Trans>
      </span>
      {!quick && run.status === 'done' && (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger className="btn">
            <Trans>Promptprofil übernehmen ▾</Trans>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="start" className={menu}>
              {run.points.map((p, i) => {
                const same = isOwnProfile(
                  connections?.find((c) => c.id === p.label.connection_id),
                  p.label.prompt_profile,
                )
                return (
                  <DropdownMenu.Item
                    key={i}
                    disabled={same}
                    className={item}
                    onSelect={() => setApplying(i)}
                  >
                    {pointName(p.label)}
                    {same && ` · ${t`schon im Betrieb`}`}
                  </DropdownMenu.Item>
                )
              })}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger className="btn">
          <Trans>Zur Anbindung ▾</Trans>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="start" className={menu}>
            {linked.map((p) => (
              <DropdownMenu.Item key={p.label.connection_id} asChild className={item}>
                <Link to={`/admin/modelle#anbindung-${p.label.connection_id}`}>
                  {p.label.connection_name}
                </Link>
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <span className="text-muted text-xs">
        <Trans>Freigeben und als Standard setzen auf der Seite Modellanbindungen.</Trans>
      </span>
      {applying !== null && (
        <ApplyProfileDialog
          run={run}
          index={applying}
          connection={connections?.find((c) => c.id === run.points[applying].label.connection_id)}
          onClose={() => setApplying(null)}
        />
      )}
    </div>
  )
}

/** "Lauf gegen anderen stellen ▾": complete runs over the same cases (V6.6). */
function CompareMenu({ run }: { run: RunView }) {
  const runs = useRuns().data?.items ?? []
  const others = runs.filter(
    (r) => r.id !== run.id && r.status === 'done' && r.case_set_hash === run.label.case_set_hash,
  )
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="btn" disabled={others.length === 0}>
        <Trans>Lauf gegen anderen stellen ▾</Trans>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          className="card z-[1300] min-w-48 bg-neutral-100 py-1 shadow-[var(--shadow-md)]"
        >
          {others.map((r) => {
            const other = r.id
            const when = formatDateTime(r.started_at)
            return (
              <DropdownMenu.Item
                key={r.id}
                asChild
                className="block cursor-pointer px-3 py-1 text-sm outline-none data-[highlighted]:bg-neutral-200"
              >
                <Link to={`${runPath(run.id)}/gegen/${r.id}`}>{t`Lauf #${other} · ${when}`}</Link>
              </DropdownMenu.Item>
            )
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

// --- the page -----------------------------------------------------------------------

function RunHeader({
  run,
  split,
  setSplit,
}: {
  run: RunView
  split: Split
  setSplit: (s: Split) => void
}) {
  const l = run.label
  const id = run.id
  const points = run.points.length
  const state = dataStateText(l.data_state)
  const quick = l.scope === 'quick'
  const when = formatDateTime(l.started_at)
  const who = l.started_by
  const cases = l.cases
  const scope = scopeText(l.scope)
  return (
    <>
      <p className="text-muted mb-1 text-sm">
        <Link to={RUNS} className="hover:text-accent-700">
          <Trans>Bewertung › Läufe</Trans>
        </Link>{' '}
        ›
      </p>
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h2 className="text-2xl">
          <Trans>Lauf #{id}</Trans>
        </h2>
        <span className="ml-auto" />
        <RunStatusLabel status={run.status} quick={quick} live />
        {run.status === 'done' && !quick && <CompareMenu run={run} />}
        {quick && run.status === 'done' && (
          <Link to={`${NEW_RUN}?von=${run.id}`} className="btn btn-primary">
            <Trans>Als vollständigen Lauf wiederholen</Trans>
          </Link>
        )}
        {run.status !== 'running' && (
          <a
            href={api.evaluation.exportRunUrl(run.id)}
            download={`lauf-${run.id}.json`}
            className="btn"
          >
            <Trans>Exportieren</Trans>
          </a>
        )}
      </div>
      <div className="text-muted mb-2 flex flex-wrap items-center gap-2 text-sm">
        <span>
          <Trans>
            {when} · {who} · {points} Messpunkte · {cases} Fälle · {state} · {scope}
          </Trans>
        </span>
        <span>
          <Trans>Teil</Trans>
        </span>
        <Choice
          label={t`Teil`}
          value={split}
          onChange={setSplit}
          options={[
            { value: 'tuning' as const, label: splitText('tuning') },
            { value: 'confirm' as const, label: splitText('confirm') },
          ]}
        />
      </div>
    </>
  )
}

function RunBody({ run }: { run: RunView }) {
  const hasTuning = run.cases.some((rc) => rc.case.split === 'tuning')
  const [split, setSplit] = useState<Split>(hasTuning ? 'tuning' : 'confirm')
  const quick = run.label.scope === 'quick'
  return (
    <div className="max-w-7xl">
      <RunHeader run={run} split={split} setSplit={setSplit} />
      {run.status === 'running' && <Progress run={run} />}
      {run.status === 'failed' && (
        <p role="alert" className="card border-ink mb-3 p-3 text-sm">
          {run.error ? runErrorText(run.error) : t`Der Lauf ist fehlgeschlagen.`}
        </p>
      )}
      {(run.status === 'aborted' || run.status === 'interrupted') && (
        <p className="card mb-3 p-3 text-sm">
          {run.status === 'aborted'
            ? t`Abgebrochen. Die bisherigen Antworten bleiben; Quoten und Vergleich gibt es nur für vollständige Läufe.`
            : t`Unterbrochen durch einen Neustart. Die bisherigen Antworten bleiben; Quoten und Vergleich gibt es nur für vollständige Läufe.`}
        </p>
      )}
      {quick && (
        <p className="card border-ink mb-3 p-3 text-sm">
          <Trans>
            Ein Block: für einen ersten Eindruck, nicht für eine Entscheidung. Keine
            Vergleichsaussage.
          </Trans>
        </p>
      )}
      <RunLabelView run={run} />
      <p className="text-muted mb-2 flex flex-wrap items-center gap-3 text-xs">
        <span>{legendText()}</span>
        <StillWrong>
          <Trans>still falsch</Trans>
        </StillWrong>
        <span>
          <Trans>= falsch ohne genannte Annahme</Trans>
        </span>
        {run.status === 'done' && (
          <span>
            <Trans>Spaltenkopf: Quote Abstimmung · Vergleich auf Bestätigung</Trans>
          </span>
        )}
      </p>
      <Matrix run={run} split={split} />
      <ColumnActions run={run} />
    </div>
  )
}

export function RunPage() {
  const { id } = useParams()
  const run = useRun(Number(id))
  if (!run.data) return run.error ? <ErrorNotice error={run.error} /> : <Loading />
  return (
    <>
      {/* A failed poll keeps what was read; polling stops after repeated failures. */}
      <ErrorNotice error={run.error} />
      <RunBody run={run.data} />
    </>
  )
}
