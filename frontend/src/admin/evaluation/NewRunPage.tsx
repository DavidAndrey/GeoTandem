// Bewertung › Neuer Lauf (design V4): one page in four steps from top to
// bottom, not a wizard (design review 4). 1 measuring points (connection,
// prompt profile, level, a system prompt copy for this run only, the
// reference as radio), 2 cases (start set or own, split, tag; one data state
// per run, D1), 3 scope (full 2 × 5 or quick 1 × 5), 4 the estimate, asked
// again at once on every change (D12), with the notice of an external host
// and its confirmation (F-9.4). While another run runs, starting is locked
// (V4.2). "Als vollständigen Lauf wiederholen" opens it with a run's request.
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { useEffect, useId, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import {
  api,
  ApiRequestError,
  type CaseOrigin,
  type CaseView,
  type ConnectionInfo,
  type CostEstimate,
  type DataState,
  type Level,
  type PromptProfile,
  type RunRequest,
  type RunScope,
  type Split,
} from '../../api/client'
import { useConnections, useLevels } from '../../api/queries'
import { ErrorNotice, Loading } from '../../components/ui'
import { formatNumber } from '../../i18n/locale'
import {
  connectionProfile,
  EXAMPLES,
  examplesText,
  isDefaultProfile,
  OUTPUTS,
  outputText,
  PLACEMENTS,
  placementText,
  sameProfile,
} from './profileOptions'
import { useCases } from './queries'
import { runKeys, useRun, useRuns } from './runs'
import { Choice } from './runParts'
import {
  clock,
  NEW_RUN,
  RUNS,
  runPath,
  durationText,
  moneyText,
  moniesText,
  progressPercent,
  scopeText,
  tokensText,
} from './runWords'
import { dataStateText, notRun, splitText, tagText } from './words'

/** At most this many measuring points (``MAX_POINTS``). */
const MAX_POINTS = 8
const OWN: CaseOrigin[] = ['authored', 'import', 'log']
/** The estimate waits this long after the last change before it asks. */
const DEBOUNCE_MS = 250

interface PointForm {
  connectionId: number
  /** ``null``: the connection's own profile. */
  profile: PromptProfile | null
  levelId: number
  /** The edited copy of the level's system prompt (D10); ``null``: the level's own. */
  systemPrompt: string | null
}

interface RunForm {
  points: PointForm[]
  reference: number
  start: boolean
  own: boolean
  /** Only when own cases run alone: the data state they run on. */
  ownState: DataState
  split: Split | null
  tag: string | null
  scope: RunScope
}

const defaultConnection = (connections: ConnectionInfo[]) =>
  connections.find((c) => c.is_default && c.enabled) ??
  connections.find((c) => c.enabled) ??
  connections[0]

const defaultLevel = (levels: Level[]) => levels.find((l) => l.is_default) ?? levels[0]

function newPoint(connections: ConnectionInfo[], levels: Level[]): PointForm {
  return {
    connectionId: defaultConnection(connections)?.id ?? 0,
    profile: null,
    levelId: defaultLevel(levels)?.id ?? 0,
    systemPrompt: null,
  }
}

/** The form from a run's request ("Als vollständigen Lauf wiederholen"), always full. */
function formOf(request: RunRequest): RunForm {
  const origins = request.cases?.origins ?? ['start']
  return {
    points: request.points.map((p) => ({
      connectionId: p.connection_id,
      profile: p.prompt_profile ?? null,
      levelId: p.level_id,
      systemPrompt: p.system_prompt ?? null,
    })),
    reference: request.reference ?? 0,
    start: origins.includes('start'),
    own: origins.some((o) => OWN.includes(o)),
    ownState: request.data_state ?? 'sample',
    split: request.cases?.split ?? null,
    tag: request.cases?.tags?.[0] ?? null,
    scope: 'full',
  }
}

function freshForm(connections: ConnectionInfo[], levels: Level[], scope: RunScope): RunForm {
  return {
    points: [newPoint(connections, levels)],
    reference: 0,
    start: true,
    own: false,
    ownState: 'live',
    split: null,
    tag: null,
    scope,
  }
}

const dataStateOf = (f: RunForm): DataState => (f.start ? 'sample' : f.ownState)

/** The request the form describes; ``null`` without a case origin or a point. */
function requestOf(
  f: RunForm,
  connections: ConnectionInfo[],
  levels: Level[],
  confirm: number[] = [],
): RunRequest | null {
  const origins: CaseOrigin[] = [...(f.start ? ['start' as const] : []), ...(f.own ? OWN : [])]
  if (!origins.length || !f.points.length) return null
  return {
    points: f.points.map((p) => {
      const connection = connections.find((c) => c.id === p.connectionId)
      const level = levels.find((l) => l.id === p.levelId)
      const own = connectionProfile(connection)
      return {
        connection_id: p.connectionId,
        prompt_profile: p.profile && !sameProfile(p.profile, own) ? p.profile : null,
        level_id: p.levelId,
        system_prompt:
          p.systemPrompt !== null && p.systemPrompt !== level?.system_prompt
            ? p.systemPrompt
            : null,
      }
    }),
    reference: Math.min(f.reference, f.points.length - 1),
    cases: { origins, split: f.split, tags: f.tag ? [f.tag] : [] },
    data_state: dataStateOf(f),
    scope: f.scope,
    confirm_external: confirm,
  }
}

/** The cases the selection runs, as the list counts them (the estimate's count decides). */
function selected(cases: CaseView[], f: RunForm): CaseView[] {
  const state = dataStateOf(f)
  return cases.filter((v) => {
    if (notRun(v.status)) return false
    const start = v.read_only
    if (start ? !f.start : !f.own) return false
    if ((v.case.data_state ?? 'sample') !== state) return false
    if (f.split && v.case.split !== f.split) return false
    if (f.tag && !v.case.tags.includes(f.tag)) return false
    return true
  })
}

/** Why the estimate cannot be had, in words. */
function estimateProblem(error: unknown, request: RunRequest | null): string | null {
  if (!error) return null
  if (
    error instanceof ApiRequestError &&
    error.body?.code === 'bad_request' &&
    request?.points.some((p) => p.prompt_profile && !isDefaultProfile(p.prompt_profile))
  )
    return t`Andere Promptprofile als Standard · P0 · erzwungen lassen sich in dieser Version noch nicht messen. Wählen Sie für jeden Messpunkt Standard · P0 · erzwungen.`
  return error instanceof Error ? error.message : String(error)
}

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return settled
}

// --- step 1: measuring points ------------------------------------------------------

function PointRow({
  point,
  index,
  form,
  setForm,
  connections,
  levels,
}: {
  point: PointForm
  index: number
  form: RunForm
  setForm: (f: RunForm) => void
  connections: ConnectionInfo[]
  levels: Level[]
}) {
  const connection = connections.find((c) => c.id === point.connectionId)
  const profile = point.profile ?? connectionProfile(connection)
  const level = levels.find((l) => l.id === point.levelId)
  const n = index + 1
  const change = (patch: Partial<PointForm>) =>
    setForm({
      ...form,
      points: form.points.map((p, i) => (i === index ? { ...p, ...patch } : p)),
    })
  const setProfile = (patch: Partial<PromptProfile>) =>
    change({ profile: { ...profile, ...patch } })
  const remove = () =>
    setForm({
      ...form,
      points: form.points.filter((_, i) => i !== index),
      reference:
        form.reference === index ? 0 : form.reference > index ? form.reference - 1 : form.reference,
    })
  const edited = point.systemPrompt !== null
  return (
    <tr>
      <td>
        <select
          className="input"
          aria-label={t`Anbindung von Messpunkt ${n}`}
          value={point.connectionId}
          onChange={(e) => change({ connectionId: Number(e.target.value), profile: null })}
        >
          {connections.map((c) => {
            const name = c.name
            return (
              <option key={c.id} value={c.id}>
                {c.locality === 'local' ? t`${name} · lokal` : `${name} · ${c.host}`}
              </option>
            )
          })}
        </select>
      </td>
      <td>
        <div className="flex gap-1">
          <select
            className="input"
            aria-label={t`Beispiele von Messpunkt ${n}`}
            value={profile.examples}
            onChange={(e) => setProfile({ examples: e.target.value as PromptProfile['examples'] })}
          >
            {EXAMPLES.map((v) => (
              <option key={v} value={v}>
                {examplesText(v)}
              </option>
            ))}
          </select>
          <select
            className="input"
            aria-label={t`Platzierung von Messpunkt ${n}`}
            value={profile.placement}
            onChange={(e) =>
              setProfile({ placement: e.target.value as PromptProfile['placement'] })
            }
          >
            {PLACEMENTS.map((v) => (
              <option key={v} value={v}>
                {placementText(v)}
              </option>
            ))}
          </select>
          <select
            className="input"
            aria-label={t`Ausgabe von Messpunkt ${n}`}
            value={profile.output}
            onChange={(e) => setProfile({ output: e.target.value as PromptProfile['output'] })}
          >
            {OUTPUTS.map((v) => (
              <option key={v} value={v}>
                {outputText(v)}
              </option>
            ))}
          </select>
        </div>
      </td>
      <td>
        <select
          className="input"
          aria-label={t`Stufe von Messpunkt ${n}`}
          value={point.levelId}
          onChange={(e) => change({ levelId: Number(e.target.value), systemPrompt: null })}
        >
          {levels.map((l) => (
            <option key={l.id ?? l.name} value={l.id ?? 0}>
              {l.name}
            </option>
          ))}
        </select>
      </td>
      <td>
        <button
          type="button"
          className={
            edited ? 'text-accent-700 text-sm' : 'text-muted hover:text-accent-700 text-sm'
          }
          aria-expanded={edited}
          onClick={() => change({ systemPrompt: edited ? null : (level?.system_prompt ?? '') })}
        >
          {edited ? t`System-Prompt geändert` : t`System-Prompt ändern`}
        </button>
      </td>
      <td>
        <label className="flex items-center gap-1 text-sm">
          <input
            type="radio"
            name="reference"
            aria-label={t`Messpunkt ${n} als Vergleichsbasis`}
            checked={form.reference === index}
            onChange={() => setForm({ ...form, reference: index })}
          />
          {form.reference === index && <span aria-hidden>{t`Basis`}</span>}
        </label>
      </td>
      <td>
        <button
          type="button"
          className="btn border-transparent px-1"
          aria-label={t`Messpunkt ${n} entfernen`}
          disabled={form.points.length === 1}
          onClick={remove}
        >
          <X size={14} aria-hidden />
        </button>
      </td>
    </tr>
  )
}

function SystemPromptCopy({
  point,
  index,
  form,
  setForm,
  connections,
  levels,
}: {
  point: PointForm
  index: number
  form: RunForm
  setForm: (f: RunForm) => void
  connections: ConnectionInfo[]
  levels: Level[]
}) {
  const id = useId()
  if (point.systemPrompt === null) return null
  const connection = connections.find((c) => c.id === point.connectionId)
  const level = levels.find((l) => l.id === point.levelId)
  const profile = point.profile ?? connectionProfile(connection)
  const name = connection?.name ?? ''
  const placement = placementText(profile.placement)
  const levelName = level?.name ?? ''
  const change = (systemPrompt: string | null) =>
    setForm({
      ...form,
      points: form.points.map((p, i) => (i === index ? { ...p, systemPrompt } : p)),
    })
  return (
    <div className="card mb-2 max-w-3xl p-3">
      <div className="mb-1 flex items-center gap-2">
        <label htmlFor={id} className="label-caps">
          {t`System-Prompt für diesen Lauf · ${name} ${placement}`}
        </label>
        <button
          type="button"
          className="text-accent-700 ml-auto text-sm"
          onClick={() => change(null)}
        >
          <Trans>auf Betrieb zurücksetzen</Trans>
        </button>
      </div>
      <textarea
        id={id}
        className="input h-28 w-full font-mono text-xs"
        maxLength={8000}
        value={point.systemPrompt}
        onChange={(e) => change(e.target.value)}
      />
      <p className="text-muted text-xs">
        {point.systemPrompt === level?.system_prompt
          ? t`Noch wie im Betrieb (Stufe ${levelName}).`
          : t`Gilt nur für diesen Lauf; ändert den Betrieb nicht. In der Beschriftung des Laufs mit Hash festgehalten.`}
      </p>
    </div>
  )
}

// --- step 4: the estimate -------------------------------------------------------------

function costCell(c: CostEstimate['connections'][number]) {
  if (c.cost) return `≈ ${moneyText(c.cost)}`
  return c.locality === 'local' ? t`lokal · kein Preis` : t`kein Preis`
}

function Estimate({ estimate }: { estimate: CostEstimate }) {
  const total = moniesText(estimate.cost)
  return (
    <table className="data-table mb-3 max-w-3xl" aria-label={t`Abschätzung`}>
      <thead>
        <tr>
          <th scope="col">
            <Trans>Anbindung</Trans>
          </th>
          <th scope="col">
            <Trans>Anfragen</Trans>
          </th>
          <th scope="col">
            <Trans>Tokens geschätzt</Trans>
          </th>
          <th scope="col">
            <Trans>Kosten geschätzt</Trans>
          </th>
          <th scope="col">
            <Trans>Dauer</Trans>
          </th>
        </tr>
      </thead>
      <tbody>
        {estimate.connections.map((c) => {
          const points = c.points
          return (
            <tr key={c.connection_id}>
              <th scope="row" className="border-divider font-normal">
                {c.name}
                {points > 1 && ` ${t`(${points} Messpunkte)`}`}
              </th>
              <td className="tabular-nums">{formatNumber(c.requests)}</td>
              <td className="tabular-nums">{tokensText(c.tokens)}</td>
              <td className="tabular-nums">{costCell(c)}</td>
              <td className="tabular-nums">{durationText(c.duration_s)}</td>
            </tr>
          )
        })}
        <tr className="font-semibold">
          <th scope="row" className="border-divider">
            <Trans>Zusammen</Trans>
          </th>
          <td className="tabular-nums">{formatNumber(estimate.requests)}</td>
          <td className="tabular-nums">{tokensText(estimate.tokens)}</td>
          <td className="tabular-nums">{total ? `≈ ${total}` : t`ohne Preis`}</td>
          <td className="tabular-nums">
            {durationText(estimate.duration_s)}{' '}
            <span className="font-normal">{t`(parallel je Anbindung)`}</span>
          </td>
        </tr>
      </tbody>
    </table>
  )
}

/** "api.anthropic.com und api.openai.com". */
const hostList = (hosts: string[]) =>
  hosts.length <= 1
    ? (hosts[0] ?? '')
    : (() => {
        const head = hosts.slice(0, -1).join(', ')
        const last = hosts[hosts.length - 1]
        return t`${head} und ${last}`
      })()

// --- the page ------------------------------------------------------------------------

function Busy({ id }: { id: number }) {
  const run = useRun(id).data
  const who = run?.label.started_by ?? ''
  const since = run ? clock(run.label.started_at) : ''
  const percent = run ? progressPercent(run.progress.done, run.progress.total) : 0
  return (
    <div
      role="status"
      className="card border-ink mb-3 flex flex-wrap items-start gap-2 p-3 text-sm"
    >
      <span className="chip">
        <Trans>Ein Lauf läuft schon</Trans>
      </span>
      <Link to={runPath(id)} className="text-accent-700 ml-auto">
        <Trans>Lauf #{id} ansehen ›</Trans>
      </Link>
      <p className="w-full">
        {run ? (
          <Trans>
            Lauf #{id} ({who}, seit {since}, {percent} %) muss fertig sein oder abgebrochen werden.
            Sie können diesen Lauf vorbereiten; Starten ist gesperrt.
          </Trans>
        ) : (
          <Trans>
            Lauf #{id} muss fertig sein oder abgebrochen werden. Sie können diesen Lauf vorbereiten;
            Starten ist gesperrt.
          </Trans>
        )}
      </p>
    </div>
  )
}

function RunFormView({
  initial,
  connections,
  levels,
  cases,
}: {
  initial: RunForm
  connections: ConnectionInfo[]
  levels: Level[]
  cases: CaseView[]
}) {
  const [form, setForm] = useState(initial)
  const [confirmedHosts, setConfirmedHosts] = useState<string | null>(null)
  const navigate = useNavigate()
  const client = useQueryClient()
  const runs = useRuns()
  const running = runs.data?.items.find((r) => r.status === 'running')
  const request = useMemo(() => requestOf(form, connections, levels), [form, connections, levels])
  const asked = useDebounced(request, DEBOUNCE_MS)
  const estimate = useQuery({
    queryKey: ['eval-estimate', asked],
    queryFn: () => api.evaluation.estimate(asked as RunRequest),
    enabled: asked !== null,
    placeholderData: keepPreviousData,
    retry: false,
  })
  const current = estimate.data
  const settled = asked === request && !estimate.isFetching && !estimate.isError
  const hosts = current?.external_hosts ?? []
  const hostKey = hosts.join(' ')
  const confirmed = hosts.length === 0 || confirmedHosts === hostKey
  const externalIds = (current?.connections ?? [])
    .filter((c) => c.locality === 'external')
    .map((c) => c.connection_id)
  const start = useMutation({
    mutationFn: (body: RunRequest) => api.evaluation.start(body),
    onSuccess: (run) => {
      void client.invalidateQueries({ queryKey: runKeys.all })
      navigate(runPath(run.id))
    },
    onError: (error) => {
      if (error instanceof ApiRequestError && error.body?.code === 'run_busy')
        void client.invalidateQueries({ queryKey: runKeys.list })
    },
  })
  const ownCases = cases.filter((v) => !v.read_only && !notRun(v.status))
  const ownLive = ownCases.filter((v) => v.case.data_state === 'live').length
  const ownSample = ownCases.length - ownLive
  const ownTotal = ownCases.length
  const hostNames = hostList(hosts)
  const startCount = cases.filter((v) => v.read_only && !notRun(v.status)).length
  const chosen = selected(cases, form)
  const tags = [...new Set(cases.flatMap((v) => v.case.tags))].sort()
  const state = dataStateText(dataStateOf(form))
  const count = current && settled ? current.cases : chosen.length
  const problem = estimateProblem(estimate.error, asked)
  const canStart =
    request !== null &&
    settled &&
    current !== undefined &&
    confirmed &&
    !running &&
    !start.isPending
  const ownWhy =
    form.start && ownSample === 0
      ? t`Eigene Fälle laufen auf Betriebsdaten; ein Lauf hat einen Datenstand, der Startbestand die Beispieldaten.`
      : null
  const startWhy =
    form.own && !form.start && form.ownState === 'live'
      ? t`Der Startbestand läuft auf den Beispieldaten; ein Lauf hat einen Datenstand.`
      : null
  const ownLabel = form.start
    ? t`Eigene (${ownSample}) · Beispieldaten`
    : ownSample && ownLive
      ? t`Eigene (${ownTotal})`
      : ownLive
        ? t`Eigene (${ownLive}) · Betriebsdaten`
        : t`Eigene (${ownSample}) · Beispieldaten`
  const startButton = (
    <button
      type="button"
      className="btn btn-primary"
      disabled={!canStart}
      onClick={() => {
        const body = requestOf(form, connections, levels, confirmed ? externalIds : [])
        if (body) start.mutate(body)
      }}
    >
      <Trans>Lauf starten</Trans>
    </button>
  )
  const ownStateFixed = ownLive === 0 ? 'sample' : ownSample === 0 ? 'live' : null
  return (
    <div className="max-w-6xl">
      <p className="text-muted mb-1 text-sm">
        <Link to={RUNS} className="hover:text-accent-700">
          <Trans>Bewertung › Läufe</Trans>
        </Link>{' '}
        ›
      </p>
      <div className="mb-3 flex items-center gap-3">
        <h2 className="text-2xl">
          <Trans>Neuer Lauf</Trans>
        </h2>
        <span className="ml-auto">{startButton}</span>
      </div>
      {running && <Busy id={running.id} />}
      <ErrorNotice error={start.error} />

      <section aria-labelledby="step-points" className="mb-4">
        <h3 id="step-points" className="label-caps mb-1 font-normal">
          <Trans>1 · Messpunkte</Trans>
        </h3>
        <table className="data-table mb-1">
          <thead>
            <tr>
              <th scope="col">
                <Trans>Anbindung</Trans>
              </th>
              <th scope="col">
                <Trans>Promptprofil · Beispiele · Platzierung · Ausgabe</Trans>
              </th>
              <th scope="col">
                <Trans>Stufe</Trans>
              </th>
              <th scope="col">
                <Trans>System-Prompt</Trans>
              </th>
              <th scope="col">
                <Trans>Vergleich</Trans>
              </th>
              <th scope="col">
                <span className="sr-only">
                  <Trans>Entfernen</Trans>
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {form.points.map((p, i) => (
              <PointRow
                key={i}
                point={p}
                index={i}
                form={form}
                setForm={setForm}
                connections={connections}
                levels={levels}
              />
            ))}
          </tbody>
        </table>
        {form.points.map((p, i) => (
          <SystemPromptCopy
            key={i}
            point={p}
            index={i}
            form={form}
            setForm={setForm}
            connections={connections}
            levels={levels}
          />
        ))}
        {form.points.length < MAX_POINTS && (
          <button
            type="button"
            className="text-accent-700 text-sm"
            onClick={() =>
              setForm({ ...form, points: [...form.points, newPoint(connections, levels)] })
            }
          >
            <Trans>+ Messpunkt</Trans>
          </button>
        )}
        <p className="text-muted text-xs">
          <Trans>
            Vorgabe je Zeile = Promptprofil der Anbindung im Betrieb. Gleiche Anbindung mehrfach ist
            erlaubt (z. B. P0 gegen P9).
          </Trans>
        </p>
      </section>

      <section aria-labelledby="step-cases" className="mb-4">
        <h3 id="step-cases" className="label-caps mb-1 font-normal">
          <Trans>2 · Prüffälle</Trans>
        </h3>
        <div className="mb-1 flex flex-wrap items-center gap-4 text-sm">
          <label className="flex items-center gap-1" title={startWhy ?? undefined}>
            <input
              type="checkbox"
              checked={form.start}
              disabled={startWhy !== null}
              onChange={(e) =>
                setForm({
                  ...form,
                  start: e.target.checked,
                  own: e.target.checked && ownSample === 0 ? false : form.own,
                })
              }
            />
            {t`Startbestand (${startCount})`}
          </label>
          <label className="flex items-center gap-1" title={ownWhy ?? undefined}>
            <input
              type="checkbox"
              checked={form.own}
              disabled={ownWhy !== null || ownCases.length === 0}
              onChange={(e) =>
                setForm({
                  ...form,
                  own: e.target.checked,
                  ownState: ownStateFixed ?? form.ownState,
                })
              }
            />
            {ownLabel}
          </label>
          {form.own && !form.start && ownStateFixed === null && (
            <Choice
              label={t`Datenstand`}
              value={form.ownState}
              onChange={(ownState) => setForm({ ...form, ownState })}
              options={[
                { value: 'live', label: dataStateText('live') },
                { value: 'sample', label: dataStateText('sample') },
              ]}
            />
          )}
          <span className="text-muted">
            <Trans>Teil</Trans>
          </span>
          <Choice
            label={t`Teil`}
            value={form.split ?? 'both'}
            onChange={(v) => setForm({ ...form, split: v === 'both' ? null : v })}
            options={[
              { value: 'both' as const, label: t`beide` },
              { value: 'tuning' as const, label: splitText('tuning') },
              { value: 'confirm' as const, label: splitText('confirm') },
            ]}
          />
          <label className="flex items-center gap-1">
            <span className="text-muted">
              <Trans>Stichwort</Trans>
            </span>
            <select
              className="input"
              value={form.tag ?? ''}
              onChange={(e) => setForm({ ...form, tag: e.target.value || null })}
            >
              <option value="">{t`alle`}</option>
              {tags.map((tag) => (
                <option key={tag} value={tag}>
                  {tagText(tag)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="text-sm">
          <strong className="tabular-nums">{t`${count} Prüffälle`}</strong>{' '}
          <Trans>· Datenstand {state}</Trans>
        </p>
        <p className="text-muted text-xs">
          {ownWhy ?? startWhy ?? (
            <Trans>
              Ein Lauf hat einen Datenstand. Startbestand und eigene Fälle auf Betriebsdaten lassen
              sich nicht mischen.
            </Trans>
          )}
        </p>
        {request === null && (
          <p role="alert" className="text-danger text-sm">
            <Trans>Wählen Sie Startbestand oder eigene Fälle.</Trans>
          </p>
        )}
      </section>

      <section aria-labelledby="step-scope" className="mb-4">
        <h3 id="step-scope" className="label-caps mb-1 font-normal">
          <Trans>3 · Umfang</Trans>
        </h3>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <Choice
            label={t`Umfang`}
            value={form.scope}
            onChange={(scope) => setForm({ ...form, scope })}
            options={[
              { value: 'full' as const, label: scopeText('full') },
              { value: 'quick' as const, label: scopeText('quick') },
            ]}
          />
          <span className="text-muted">
            <Trans>Schnelltest: ein Block, ohne Vergleichsaussage</Trans>
          </span>
        </div>
      </section>

      <section aria-labelledby="step-estimate" className="mb-4">
        <h3 id="step-estimate" className="label-caps mb-1 font-normal">
          <Trans>4 · Abschätzung vor dem Start</Trans>
        </h3>
        {problem && (
          <p role="alert" className="text-danger mb-2 text-sm">
            {problem}
          </p>
        )}
        {!problem && !current && request && <Loading />}
        {current && !problem && (
          <div aria-busy={!settled} className={settled ? '' : 'opacity-60'}>
            <Estimate estimate={current} />
          </div>
        )}
        {current && !problem && hosts.length > 0 && (
          <div className="card border-ink max-w-3xl p-3 text-sm">
            <p className="mb-1">
              <Trans>
                Steckbrief und Fragen gehen an <span className="font-mono">{hostNames}</span>;{' '}
                <strong>keine Geodaten-Inhalte</strong>.
              </Trans>
            </p>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmedHosts(e.target.checked ? hostKey : null)}
              />
              <Trans>Verstanden, extern senden</Trans>
            </label>
            {!confirmed && (
              <p className="text-muted text-xs">
                <Trans>Ohne Haken bleibt „Lauf starten“ gesperrt.</Trans>
              </p>
            )}
          </div>
        )}
        {/* Again at the end, after the confirmation, for whoever works down the page by keyboard. */}
        <div className="mt-3">{startButton}</div>
      </section>
    </div>
  )
}

export function NewRunPage() {
  const [params] = useSearchParams()
  const from = Number(params.get('von') ?? 0)
  const quick = params.get('umfang') === 'schnell'
  const connections = useConnections()
  const levels = useLevels()
  const cases = useCases()
  const source = useRun(from, from > 0)
  const error = connections.error ?? levels.error ?? cases.error ?? source.error
  const ready = connections.data && levels.data && cases.data && (from > 0 ? source.data : true)
  if (error) return <ErrorNotice error={error} />
  if (!ready || !connections.data || !levels.data || !cases.data) return <Loading />
  if (connections.data.length === 0)
    return (
      <p className="text-sm">
        <Trans>
          Für einen Lauf braucht es eine Modellanbindung.{' '}
          <Link to="/admin/modelle" className="text-accent-700">
            Modellanbindungen
          </Link>
        </Trans>
      </p>
    )
  const levelList = levels.data.levels.filter((l) => l.id != null)
  const initial = source.data
    ? formOf(source.data.request)
    : freshForm(connections.data, levelList, quick ? 'quick' : 'full')
  return (
    <RunFormView
      key={`${NEW_RUN}-${from}`}
      initial={initial}
      connections={connections.data}
      levels={levelList}
      cases={cases.data.items}
    />
  )
}
