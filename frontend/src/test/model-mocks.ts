// Modus B as the fake API answers it (plan WP62), built from the contract
// fixture the backend and e2e use too (schema/model-cases/v1.json): a case's
// answer and expectation become the action record the backend will return.
import design from '../../../design/e2/fixture/modus-b.json'
import fixture from '../../../schema/model-cases/v1.json'
import type {
  ActionPreview,
  ActionStatus,
  Decision,
  ExecuteResponse,
  Governance,
  LevelOption,
  ModelActionView,
  ModelAnswer,
  OpClass,
  PlanEdit,
  QueryObject,
  QueryResult,
  RejectReason,
  StepView,
  StopReason,
} from '../api/client'

type Case = (typeof fixture.cases)[number]
export type LevelName = (typeof fixture.levels)[number]['name']
export type CaseId = Case['id']

export const MODEL_LIMITS = fixture.limits

/** Cases that end in a record; the others are refused before the model is asked. */
export const RECORD_CASES = fixture.cases.filter((c) => 'status' in c.expect).map((c) => c.id)

export function modelCase(id: CaseId): Case {
  const found = fixture.cases.find((c) => c.id === id)
  if (!found) throw new Error(`no model case '${id}'`)
  return found
}

function level(name: LevelName) {
  const index = fixture.levels.findIndex((l) => l.name === name)
  const found = fixture.levels[index]
  return {
    id: index + 1,
    name: found.name,
    matrix: found.matrix as ModelActionView['level']['matrix'],
    prompt_hash: `sha256:level-${index + 1}`,
  }
}

/**
 * A level as ``GET /api/llm/options`` lists it, with its matrix (design M7.1,
 * M7.2). Ids as in ``actionView``'s snapshots.
 */
export function levelOption(name: LevelName, description = ''): LevelOption {
  const snapshot = level(name)
  const found = fixture.levels.find((l) => l.name === name)
  return {
    id: snapshot.id,
    name,
    description,
    selectable: found?.selectable ?? true,
    matrix: snapshot.matrix,
  }
}

const CONNECTION = {
  id: 1,
  name: fixture.connections[0].name,
  model: fixture.connections[0].model,
  host: 'host.docker.internal',
  locality: 'local' as const,
}

const FINAL: Partial<Record<ActionStatus, Decision>> = { failed: 'failed', aborted: 'aborted' }

// What the record says once the model has answered: the fixture's status, or for
// a level the case does not list, what the level's cell makes of it (D1, D2).
function statusOf(c: Case, levelName: LevelName): ActionStatus {
  const status: unknown = 'status' in c.expect ? c.expect.status : undefined
  if (status === undefined) throw new Error(`case '${c.id}' is refused before any record exists`)
  return typeof status === 'string'
    ? (status as ActionStatus)
    : ((status as Partial<Record<LevelName, ActionStatus>>)[levelName] ??
        (governance(c, levelName)?.cell === 'auto' ? 'approved' : 'proposed'))
}

function governance(c: Case, levelName: LevelName): Governance | null {
  // A chain is governed by all its steps' classes (H4).
  const listed = ('classes' in c.expect ? c.expect.classes : undefined) ?? []
  const steps = ('step_classes' in c.expect ? c.expect.step_classes : undefined) ?? []
  const classes = [...new Set([...listed, ...steps])] as OpClass[]
  if (classes.length === 0) return null
  const matrix = level(levelName).matrix
  const cells = classes.map((k) => matrix[k])
  const cell = cells.includes('off') ? 'off' : cells.includes('approve') ? 'approve' : 'auto'
  return {
    classes,
    cell,
    needs_approval: classes.filter((k) => matrix[k] === 'approve'),
    off: classes.filter((k) => matrix[k] === 'off'),
  }
}

/** The record the backend returns for a case, at a level (default: the default level). */
export function actionView(
  id: CaseId,
  patch: Partial<ModelActionView> = {},
  levelName: LevelName = 'Prüfen',
): ModelActionView {
  const c = modelCase(id)
  const status = statusOf(c, levelName)
  const answer = ('answer' in c ? c.answer : null) as ModelAnswer | null
  const expect = c.expect as Record<string, unknown>
  const failed = status === 'failed' || status === 'aborted'
  const refused = status === 'refused'
  const decision = FINAL[status] ?? null
  const governed = refused ? null : governance(c, levelName)
  return {
    id: fixture.cases.indexOf(c) + 1,
    account: 'admin',
    // Naive UTC, as the server writes every time (``parseTimestamp``).
    created_at: '2026-10-10T14:05:00',
    decided_at: decision ? '2026-10-10T14:05:06' : null,
    prompt: c.prompt,
    approach: c.approach as ModelActionView['approach'],
    status,
    decision,
    reject_reason: null,
    // As the server stores it (D1): a class ``off`` at the level as it was.
    proposal_only: (governed?.off.length ?? 0) > 0,
    applied_by_hand: false,
    undone_at: null,
    previewed_at: null,
    parent_action_id: 'parent' in c ? fixture.cases.findIndex((p) => p.id === c.parent) + 1 : null,
    reference: (expect.reference as ModelActionView['reference']) ?? 'none',
    compare_of: null,
    level: level(levelName),
    connection: CONNECTION,
    profile_hash: 'sha256:profile',
    prompt_hash: 'sha256:prompt',
    answer: failed ? null : answer,
    query: !refused && answer?.kind === 'query' ? (answer.query as unknown as QueryObject) : null,
    applied_query: null,
    governance: governed,
    refusal: refused
      ? {
          code: expect.refusal_code as NonNullable<ModelActionView['refusal']>['code'],
          message: 'refused',
          details: (expect.details as Record<string, unknown>) ?? {},
        }
      : null,
    error: status === 'failed' ? { code: expect.error_code, message: 'failed', details: {} } : null,
    // A plan's steps as the server stores them (WP75): planned, each with its class and cell.
    steps: !refused && !failed && answer?.kind === 'plan' ? planSteps(c, levelName) : [],
    replans: 0,
    stop_reason: null,
    stamp: null,
    latency_ms: 6000,
    ...patch,
  }
}

type PlanAnswer = Extract<ModelAnswer, { kind: 'plan' }>
type PlannedStep = PlanAnswer['steps'][number]

/** A planned step as ``StepView`` (WP75): its class from the fixture, its cell at the level as it was. */
function stepView(
  step: PlannedStep,
  position: number,
  k: OpClass,
  levelName: LevelName,
  revised = false,
): StepView {
  return {
    position,
    text: step.text,
    tool: step.tool,
    arguments: step.arguments,
    classes: [k],
    cell: level(levelName).matrix[k],
    status: 'planned',
    revised,
    hits: null,
    stamp: null,
    layer: null,
    model_view: null,
    duration_ms: null,
  }
}

function planSteps(c: Case, levelName: LevelName): StepView[] {
  const plan = c.answer as unknown as PlanAnswer
  const classes = ('step_classes' in c.expect ? c.expect.step_classes : []) as OpClass[]
  return plan.steps.map((step, i) => stepView(step, i + 1, classes[i] ?? 'query', levelName))
}

/**
 * A query object as a full pydantic dump writes it (``model_dump`` without
 * ``compact``): every unset field ``null``, every empty default ``[]``, a
 * relation without filter with ``where: null``. The server sends the compact
 * form; the frontend must read this one the same (``compactQuery``).
 */
export function serverShape(query: unknown): QueryObject {
  const condition = (c: unknown): unknown => {
    if (c === null || typeof c !== 'object') return c
    const json = c as Record<string, unknown>
    if (json.op === 'and' || json.op === 'or')
      return { ...json, args: (json.args as unknown[]).map(condition) }
    if (json.op === 'not') return { ...json, arg: condition(json.arg) }
    if (json.op === 'related') return { where: null, ...json }
    return json
  }
  const q = query as Record<string, unknown>
  return {
    attribute_join: null,
    buffer: null,
    spatial_relation: null,
    aggregate: null,
    columns: [],
    select: null,
    order_by: [],
    limit: null,
    symbology: null,
    ...q,
    where: q.where === undefined ? null : condition(q.where),
  } as unknown as QueryObject
}

/** The record while the model thinks: what ``POST /api/model/prompt`` answers (P7). */
export function thinkingView(id: CaseId, levelName: LevelName = 'Prüfen'): ModelActionView {
  return actionView(
    id,
    { status: 'thinking', decision: null, decided_at: null, answer: null, query: null },
    levelName,
  )
}

/** Fake-API routes for one prompt (see ``fakeApi``): the POST answers 202 with
 * the thinking record, polling the record brings the answer (P7). */
export function promptRoutes(id: CaseId, levelName: LevelName = 'Prüfen') {
  const answered = actionView(id, {}, levelName)
  const thinking = thinkingView(id, levelName)
  return {
    'POST /api/model/prompt': () => new Response(JSON.stringify(thinking), { status: 202 }),
    [`GET /api/model/actions/${answered.id}`]: answered,
  }
}

// --- Enforcement (WP70) as the fake server answers it -----------------------
//
// The routes as WP70's server answers them (api/model.py, model/service.py,
// model/record/store.py at fdd97f7), checked in the server's order:
// - ``approve``: status ``proposed`` (else ``_wrong_state``), then no class
//   ``off`` (409 ``class_not_allowed`` {part, op_class, level}).
// - ``reject`` {reason}: ``proposed`` only; decision ``rejected`` with the reason.
// - ``execute`` (no body): status ``approved``, then no class ``off``, then a
//   stored query (else ``not_approved``); decision ``auto`` when the cell is
//   ``auto``, else ``accepted``; answers ``ExecuteResponse`` {action, result}.
// - ``preview``: a session (403 ``session_required`` for a token), status
//   ``proposed``/``approved``, no class ``off``, a stored query; sets
//   ``previewed_at``, never the status.
// - ``undo``: ``applied`` (an ``undone`` record ``already_decided``, any other
//   ``nothing_to_undo``), then a decision ``accepted``/``auto`` (else
//   ``nothing_to_undo``), then not touched (``undo_blocked``), then the
//   account's latest model change (else ``nothing_to_undo``): of all its
//   records ``applied`` or ``undone`` with a decision ``accepted``/``auto``,
//   the latest ``decided_at``, then the highest id.
// - ``touched``: ``applied`` only (else 409 ``nothing_to_undo``); sets
//   ``touched_at``, the first report's time stays.
// - ``decide``: ``proposal_only`` only for a proposal-only record (its stored
//   ``proposal_only``), else 409 ``not_approved`` (WP71).
// - Any other wrong status: 409 ``already_decided`` on a decided record, else
//   409 ``not_approved`` (the store's ``_wrong_state``).
// Times are naive UTC with microseconds, as the server writes them.

/** Statuses with an edge out of them (store.py ``EDGES``). */
const MOVABLE: readonly ActionStatus[] = [
  'thinking',
  'proposed',
  'approved',
  'running',
  'done',
  'limited',
  'applied',
]

export interface FakeError {
  status: number
  body: { code: string; message: string; details: Record<string, unknown> }
}

const fail = (
  code: string,
  message: string,
  details: Record<string, unknown>,
  status = 409,
): FakeError => ({ status, body: { code, message, details } })

export const isFakeError = (value: unknown): value is FakeError =>
  typeof value === 'object' && value !== null && 'body' in value && 'status' in value

/** The ten of 137 the reference question finds (fixture ``reference``: hits, total). */
export const REFERENCE_IDS = [3, 8, 15, 21, 34, 55, 61, 89, 104, 130]

/** A result as the engine sends it: one point per id. */
export function queryResult(
  query: QueryObject | null | undefined,
  ids: readonly number[],
): QueryResult {
  return {
    type: 'FeatureCollection',
    features: ids.map((id) => ({
      type: 'Feature' as const,
      id,
      properties: { name: `Schule ${id}` },
      geometry: { type: 'Point', coordinates: [7.9, 46.9] },
    })),
    query: (query ?? { schema_version: '2', source: 'schulen' }) as QueryResult['query'],
    meta: {
      schema_version: '2',
      query_hash: 'sha256:query',
      data_versions: { schulen: 'v1' },
      backend: 'sqlite',
      feature_count: ids.length,
      elapsed_ms: 12,
    },
  }
}

// --- The tool chain (WP75) as the fake server answers it ---------------------
//
// WP75's server is not built yet: its routes answer 501. The rules here follow
// plan P4, P7, the state diagram of 1.2 and the contract (``schemas.py``);
// every choice those leave open is marked ASSUMED, for the integrator to check
// against WP75's server.
// - ``approve`` (shared with a query answer): ``proposed`` → ``approved``.
//   ASSUMED: when no step's cell is ``auto`` (Prüfen) the approval clears every
//   remaining step (one approval for the whole chain); otherwise it clears the
//   next step only (Teilautonom: the start, then each halt).
// - ``run`` (202): ``approved`` chains only, else 409 as any wrong state; the
//   record becomes ``running`` with its next step ``running``.
// - ``GET .../actions/{id}`` (polling): ASSUMED pacing, one step per poll (the
//   server runs in the background and persists each step as it finishes). A
//   step finishes ``ok`` (``empty`` at 0 hits) with ``hits``, ``stamp``,
//   ``duration_ms``, ``model_view`` {outcome, empty, count} and ``layer``
//   (ASSUMED: the owner reads it through ``POST /api/query`` with ``source``,
//   like any layer, for the dimmed map). Before a step whose cell is
//   ``approve`` and that no approval cleared, the chain halts: ``proposed``,
//   that step ``waiting`` (P4, M9.2). After the last step: ``done`` with
//   ``query`` (the result as one query object, as written: compact) and
//   ``stamp``.
// - Re-plan (P4): after an empty intermediate step, at most ``replans`` times,
//   the remaining steps are replaced by the script's (``revised: true``;
//   ASSUMED: positions continue after the kept ones); kept + revised beyond
//   ``steps`` ⇒ ``limited`` with ``step_limit``. Approval again: when no step
//   is ``auto`` (Prüfen) ``proposed`` with no step ``waiting``; otherwise the
//   halt rule (Teilautonom at revised ``approve`` steps, Automatisch never).
//   An empty final step is the result (0 hits), no re-plan.
// - Limits: ``result_too_large`` at a step makes it ``error`` with
//   ``model_view.code``; ``time_limit`` stops before the step. The record is
//   ``limited`` with ``stop_reason``, the steps left ``skipped``, ``query`` the
//   last complete result, and ASSUMED: ``error`` {code, message, details
//   {position, value, max}} carries the numbers M9.5 shows.
// - ``abort``: ``thinking`` ⇒ ``aborted`` (P7); ``running`` ⇒ the running step
//   finishes (P4: stops before the next step), then ``limited``/``aborted``,
//   decision still open (P7). ASSUMED: a chain halted for approval (``proposed``
//   after a step ran) aborts the same way (design M9.2 "Kette abbrechen" →
//   M9.4; the 1.2 diagram draws no ``proposed → limited`` edge).
// - ``adopt``: ``done`` or ``limited`` with a complete result (else 409
//   ``not_approved``); → ``applied`` with decision ``accepted`` (ASSUMED at
//   every level: the user clicked), answering ``ExecuteResponse``: the record
//   (``query`` compact) and the rows (``result.query`` a full dump).
// - ``PATCH .../plan``: ``proposed`` and not started (else 409); ``remove``
//   marks steps ``removed`` (ASSUMED: they stay in the list with that status);
//   a ``change`` may change values only, every name staying (else 422);
//   removing a step a later one reads (fixture keys ``of``/``in``, provisional
//   until WP74) and removing every step ⇒ 422 ``invalid_query`` (ASSUMED code)
//   naming the step. Never adds a step.
// - What a stopped chain adopts is WP75's ("Kette übernehmen"): the fake takes
//   the first step's condition on its layer as a placeholder.

/** What a run meets on its way (``modelServer``'s ``script``); without one it runs through. */
export interface ChainScript {
  /** Hits by position; default ``CHAIN_HITS``. 0 makes the step ``empty``. */
  hits?: Record<number, number>
  /** A limit met when the step at ``position`` runs. */
  limit?: { position: number; reason: 'result_too_large' | 'time_limit'; value?: number }
  /** The revised remaining steps of each re-plan in turn, with their classes. */
  replans?: { steps: PlannedStep[]; classes: OpClass[] }[]
}

const CHAIN_CASE = modelCase('chain_reference')

/** Step durations of the reference chain (design fixture ``referenzfrage.kette``: 3.6 s in all). */
export const CHAIN_DURATIONS_MS = design.referenzfrage.kette.map((s) =>
  Math.round(s.dauer_s * 1000),
)

/**
 * Hits of the reference chain's steps: the design's intermediate counts stand
 * in until WP75 pins them from the sample data; the last is the contract's
 * (``chain_reference``: 10 of 137).
 */
export const CHAIN_HITS: number[] = design.referenzfrage.kette.map((s, i, all) =>
  i === all.length - 1
    ? (CHAIN_CASE.expect as { hits: number }).hits
    : typeof s.ergebnis === 'number'
      ? s.ergebnis
      : 1,
)

/** A finished chain's result: the reference question's query (WP79: both approaches end equal). */
const CHAIN_RESULT = (modelCase('reference').answer as { query: unknown }).query as QueryObject

const complete = (s: StepView) => s.status === 'ok' || s.status === 'empty'

const isPlan = (view: ModelActionView) => view.answer?.kind === 'plan'

const started = (view: ModelActionView) =>
  view.steps.some((s) => s.status !== 'planned' && s.status !== 'removed')

/** Prüfen-shaped: no step runs without approval, so one approval covers the chain (ASSUMED). */
const wholeChain = (steps: StepView[]) =>
  !steps.some((s) => s.status !== 'removed' && s.cell === 'auto')

const stampOf = (count: number): NonNullable<StepView['stamp']> => ({
  count,
  ids_hash: 'sha256:ids',
  query_hash: 'sha256:query',
  data_versions: { schulen: 'v1' },
})

/** The last complete result of a stopped chain as a query object (a placeholder, see above). */
function partialResult(steps: StepView[]): QueryObject | null {
  const last = [...steps].reverse().find(complete)
  if (!last) return null
  if (last.position === steps.length) return CHAIN_RESULT
  const first = steps[0]?.arguments as { layer?: string; where?: unknown } | undefined
  return {
    schema_version: '2',
    source: first?.layer ?? 'schulen',
    ...(first?.where ? { where: first.where } : {}),
  } as QueryObject
}

/** The keys of a query object that hold a value (``model/chain/steps.ts``). */
const VALUE_KEYS = ['value', 'values', 'min', 'max', 'text', 'distance_m']

/** Whether ``b`` differs from ``a`` in values only: every key and name the same. */
function sameNames(a: unknown, b: unknown, key = ''): boolean {
  if (VALUE_KEYS.includes(key)) return true
  if (Array.isArray(a))
    return Array.isArray(b) && a.length === b.length && a.every((x, i) => sameNames(x, b[i], key))
  if (typeof a !== 'object' || a === null) return a === b
  if (typeof b !== 'object' || b === null || Array.isArray(b)) return false
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  return (
    keys.length === Object.keys(right).length &&
    keys.every((k) => k in right && sameNames(left[k], right[k], k))
  )
}

/** The steps a step reads (fixture ``within`` {of, in}; provisional until WP74). */
const readsOf = (args: Record<string, unknown>): number[] =>
  ['of', 'in'].map((k) => args[k]).filter((v): v is number => typeof v === 'number')

/**
 * The model routes of one account as the server answers them: one store for
 * all records, so "the last model change" spans records as on the server.
 * Each step returns its answer or a ``FakeError``.
 */
export function modelServer(
  views: readonly ModelActionView[],
  preview: ActionPreview = { count: 10, total: 137, ids: REFERENCE_IDS },
  script: ChainScript = {},
) {
  const records = new Map(views.map((v) => [v.id, v]))
  let tick = 0
  const now = () => {
    tick += 1
    const minute = String(5 + tick).padStart(2, '0')
    return `2026-10-10T14:${minute}:00.${String(tick * 1000 + 271).padStart(6, '0')}`
  }
  const set = (view: ModelActionView) => {
    records.set(view.id, view)
    return view
  }
  const wrongState = (view: ModelActionView, step: string): FakeError =>
    view.decision !== null || !MOVABLE.includes(view.status)
      ? fail('already_decided', `Model action ${view.id} is decided already (${view.status}).`, {
          id: view.id,
          status: view.status,
          decision: view.decision,
        })
      : fail(
          'not_approved',
          `Model action ${view.id} is ${view.status}; '${step}' does not apply.`,
          {
            id: view.id,
            status: view.status,
          },
        )
  const offClass = (view: ModelActionView): FakeError | null => {
    const off = view.governance?.off ?? []
    return off.length
      ? fail(
          'class_not_allowed',
          `The level of model action ${view.id} does not allow '${off[0]}'.`,
          {
            id: view.id,
            part: off[0],
            op_class: off[0],
            level: view.level.name,
          },
        )
      : null
  }
  const noQuery = (view: ModelActionView, step: string): FakeError | null =>
    view.query
      ? null
      : fail(
          'not_approved',
          `Model action ${view.id} has no query of its own; '${step}' does not apply.`,
          {
            id: view.id,
            status: view.status,
          },
        )
  /** The account's last model change (store.py ``undo``): every record, not only this run's. */
  const latest = (): number | null => {
    const changes = [...records.values()].filter(
      (v) =>
        (v.status === 'applied' || v.status === 'undone') &&
        (v.decision === 'accepted' || v.decision === 'auto'),
    )
    // Naive UTC times of one form compare as text: decided_at, then the id.
    changes.sort((a, b) =>
      (a.decided_at ?? '') === (b.decided_at ?? '')
        ? b.id - a.id
        : (b.decided_at ?? '') > (a.decided_at ?? '')
          ? 1
          : -1,
    )
    return changes[0]?.id ?? null
  }
  const nothingToUndo = (view: ModelActionView, why: string): FakeError =>
    fail('nothing_to_undo', `Model action ${view.id} cannot be undone: ${why}.`, {
      id: view.id,
      status: view.status,
      decision: view.decision,
    })
  // --- The tool chain (see the rules above ``ChainScript``) ---
  /** Steps an approval cleared to run without a halt, by record. */
  const cleared = new Map<number, Set<number>>()
  let held = false
  const clear = (view: ModelActionView) => {
    const done = cleared.get(view.id) ?? new Set<number>()
    const open = view.steps.filter((s) => s.status === 'planned' || s.status === 'waiting')
    // Every step needs approval (Prüfen): one approval for the rest of the chain.
    const targets = wholeChain(view.steps) ? open : open.slice(0, 1)
    for (const s of targets) done.add(s.position)
    cleared.set(view.id, done)
  }
  const halts = (view: ModelActionView, s: StepView) =>
    s.cell === 'approve' && !cleared.get(view.id)?.has(s.position)
  /** The next step, or the end: ``done``, a halt (``proposed``, ``waiting``), or ``running``. */
  const proceed = (view: ModelActionView, steps: StepView[]): ModelActionView => {
    const next = steps.find((s) => s.status === 'planned' || s.status === 'waiting')
    if (!next) {
      const last = [...steps].reverse().find(complete)
      return { ...view, steps, status: 'done', query: CHAIN_RESULT, stamp: last?.stamp ?? null }
    }
    if (halts(view, next)) {
      next.status = 'waiting'
      return { ...view, steps, status: 'proposed' }
    }
    next.status = 'running'
    return { ...view, steps, status: 'running' }
  }
  const finish = (view: ModelActionView, s: StepView) => {
    const hits = script.hits?.[s.position] ?? CHAIN_HITS[s.position - 1] ?? 1
    s.status = hits === 0 ? 'empty' : 'ok'
    s.hits = hits
    s.duration_ms = CHAIN_DURATIONS_MS[s.position - 1] ?? 500
    s.layer = `chain_${view.id}_${s.position}`
    s.stamp = stampOf(hits)
    s.model_view = { outcome: 'ok', empty: hits === 0, count: hits }
  }
  const stop = (
    view: ModelActionView,
    steps: StepView[],
    reason: StopReason,
    details: Record<string, unknown> | null = null,
  ): ModelActionView => {
    for (const s of steps)
      if (s.status === 'planned' || s.status === 'waiting' || s.status === 'running')
        s.status = 'skipped'
    return {
      ...view,
      steps,
      status: 'limited',
      stop_reason: reason,
      query: partialResult(steps),
      error: details ? { code: reason, message: `Stopped: ${reason}.`, details } : null,
    }
  }
  const replan = (view: ModelActionView, steps: StepView[]): ModelActionView | null => {
    const revision = script.replans?.[view.replans]
    if (!revision || view.replans >= MODEL_LIMITS.replans) return null
    // Completed steps are fixed; the remaining ones are replaced (P4).
    const kept = steps.filter((s) => s.status !== 'planned' && s.status !== 'waiting')
    const ran = kept.filter((s) => s.status !== 'removed').length
    const total = ran + revision.steps.length
    if (total > MODEL_LIMITS.steps)
      return stop(view, steps, 'step_limit', { max: MODEL_LIMITS.steps, value: total })
    const revised = revision.steps.map((planned, i): StepView => {
      const k = revision.classes[i] ?? 'query'
      return {
        ...stepView(planned, kept.length + i + 1, k, 'Prüfen', true),
        cell: view.level.matrix[k],
      }
    })
    const next = { ...view, replans: view.replans + 1 }
    const all = [...kept, ...revised]
    // Prüfen asks again for the whole rest; Teilautonom halts at revised ``approve`` steps.
    if (wholeChain(all)) {
      cleared.delete(view.id)
      return { ...next, steps: all, status: 'proposed' }
    }
    return proceed(next, all)
  }
  const advance = (view: ModelActionView): ModelActionView => {
    const steps = view.steps.map((s) => ({ ...s }))
    const running = steps.find((s) => s.status === 'running')
    if (!running) return view
    const limit = script.limit?.position === running.position ? script.limit : null
    if (limit) {
      if (limit.reason === 'time_limit')
        return stop(view, steps, 'time_limit', { max: MODEL_LIMITS.chain_s })
      running.status = 'error'
      running.duration_ms = CHAIN_DURATIONS_MS[running.position - 1] ?? 500
      running.model_view = { outcome: 'error', code: 'result_too_large' }
      return stop(view, steps, 'result_too_large', {
        position: running.position,
        value: limit.value ?? MODEL_LIMITS.max_features + 1,
        max: MODEL_LIMITS.max_features,
      })
    }
    finish(view, running)
    const rest = steps.some((s) => s.status === 'planned')
    if (running.status === 'empty' && rest) {
      const revised = replan(view, steps)
      if (revised) return revised
    }
    return proceed(view, steps)
  }

  function step<T>(id: number, run: (view: ModelActionView) => T | FakeError): T | FakeError {
    const view = records.get(id)
    return view ? run(view) : fail('not_found', `No model action ${id}.`, { id }, 404)
  }

  return {
    record: (id: number) => records.get(id),
    /** ``token``: the request carries a token, not the login cookie (P2: session only). */
    preview: (id: number, token = false) =>
      token
        ? fail('session_required', 'Only an interactive session may do this.', {}, 403)
        : step<ActionPreview>(id, (view) => {
            if (view.status !== 'proposed' && view.status !== 'approved')
              return wrongState(view, 'preview')
            const refused = offClass(view) ?? noQuery(view, 'preview')
            if (refused) return refused
            set({ ...view, previewed_at: now() })
            return preview
          }),
    approve: (id: number) =>
      step<ModelActionView>(id, (view) => {
        if (view.status !== 'proposed') return wrongState(view, 'approve')
        const refused = offClass(view)
        if (refused) return refused
        if (isPlan(view)) clear(view)
        return set({ ...view, status: 'approved' })
      }),
    reject: (id: number, reason: RejectReason | null) =>
      step<ModelActionView>(id, (view) =>
        view.status !== 'proposed'
          ? wrongState(view, 'reject')
          : set({
              ...view,
              status: 'rejected',
              decision: 'rejected',
              reject_reason: reason,
              decided_at: now(),
            }),
      ),
    execute: (id: number) =>
      step<ExecuteResponse>(id, (view) => {
        if (view.status !== 'approved') return wrongState(view, 'execute')
        const refused = offClass(view) ?? noQuery(view, 'execute')
        if (refused) return refused
        const auto = view.governance?.cell === 'auto'
        const result = queryResult(view.query, preview.ids)
        const action = set({
          ...view,
          status: 'applied',
          decision: auto ? 'auto' : 'accepted',
          decided_at: now(),
          stamp: {
            count: result.features.length,
            ids_hash: 'sha256:ids',
            query_hash: 'sha256:query',
            data_versions: { schulen: 'v1' },
          },
        })
        return { action, result }
      }),
    undo: (id: number) =>
      step<ModelActionView>(id, (view) => {
        if (view.status === 'undone') return wrongState(view, 'undo')
        if (view.status !== 'applied')
          return nothingToUndo(view, `it changed nothing (${view.status})`)
        if (view.decision !== 'accepted' && view.decision !== 'auto')
          return nothingToUndo(view, 'it was applied by the user, not by the model')
        if (view.touched_at)
          return fail(
            'undo_blocked',
            `Model action ${view.id} cannot be undone: the analysis was changed by hand after it.`,
            { id: view.id, touched_at: view.touched_at },
          )
        const last = latest()
        if (last !== view.id)
          return nothingToUndo(view, `a later model change (${last}) came after it`)
        return set({ ...view, status: 'undone', undone_at: now() })
      }),
    touched: (id: number) =>
      step<ModelActionView>(id, (view) => {
        if (view.status !== 'applied')
          return nothingToUndo(view, `it is no applied change (${view.status})`)
        return set({ ...view, touched_at: view.touched_at ?? now() })
      }),
    /** ``decide`` (WP65): the hand-over of a proposal, once. */
    decide: (
      id: number,
      body: { decision: 'proposal_only' | 'adjusted'; applied_by_hand?: boolean; query?: unknown },
    ) =>
      step<ModelActionView>(id, (view) => {
        const byHand = body.applied_by_hand ?? false
        if (body.decision === 'adjusted' && byHand)
          return fail('bad_request', 'adjusted is not by hand', {}, 400)
        if ((body.decision === 'adjusted') !== (body.query !== undefined && body.query !== null))
          return fail('bad_request', 'adjusted, and only that, names the applied query', {}, 400)
        if (view.status !== 'proposed') return wrongState(view, 'decide')
        // WP71: ``proposal_only`` belongs to a proposal-only record (store.py ``decide``).
        if (body.decision === 'proposal_only' && !view.proposal_only)
          return fail(
            'not_approved',
            `Model action ${view.id} waits for approval: 'proposal_only' is for a proposal whose level has an 'off' part.`,
            { id: view.id, status: view.status },
          )
        return set({
          ...view,
          status: 'applied',
          decision: body.decision,
          applied_by_hand: byHand,
          applied_query: (body.query ?? null) as ModelActionView['applied_query'],
          decided_at: now(),
        })
      }),

    // --- The tool chain (WP75) ---
    /** ``GET .../actions/{id}``: the record; a running chain one step further each time (unless held). */
    poll: (id: number) =>
      step<ModelActionView>(id, (view) =>
        view.status === 'running' && !held ? set(advance(view)) : view,
      ),
    /** Holds the run where it is (``true``) or lets it go on, e.g. to look at M9.1. */
    hold: (on: boolean) => {
      held = on
    },
    /** ``POST .../run`` (202): an approved chain starts its next step. */
    run: (id: number) =>
      step<ModelActionView>(id, (view) => {
        if (view.status !== 'approved' || !isPlan(view)) return wrongState(view, 'run')
        const steps = view.steps.map((s) => ({ ...s }))
        const next = steps.find((s) => s.status === 'planned' || s.status === 'waiting')
        if (next) next.status = 'running'
        return set({ ...view, status: 'running', steps })
      }),
    /** ``POST .../abort``: thinking ⇒ ``aborted``; a run or a halt ⇒ ``limited``/``aborted``. */
    abort: (id: number) =>
      step<ModelActionView>(id, (view) => {
        if (view.status === 'thinking')
          return set({ ...view, status: 'aborted', decision: 'aborted', decided_at: now() })
        const halted = view.status === 'proposed' && started(view)
        if (!isPlan(view) || (view.status !== 'running' && !halted))
          return wrongState(view, 'abort')
        const steps = view.steps.map((s) => ({ ...s }))
        // Stops before the next step: the one running finishes (P4).
        const running = steps.find((s) => s.status === 'running')
        if (running) finish(view, running)
        return set(stop(view, steps, 'aborted'))
      }),
    /** ``POST .../adopt``: a ``done`` or ``limited`` chain's result becomes the analysis. */
    adopt: (id: number) =>
      step<ExecuteResponse>(id, (view) => {
        if (!isPlan(view) || (view.status !== 'done' && view.status !== 'limited'))
          return wrongState(view, 'adopt')
        if (!view.query)
          return fail('not_approved', `Model action ${view.id} has no complete result to adopt.`, {
            id: view.id,
            status: view.status,
          })
        const last = [...view.steps].reverse().find(complete)
        const ids =
          view.status === 'done'
            ? preview.ids
            : Array.from({ length: last?.hits ?? 0 }, (_, i) => i + 1)
        const result = queryResult(serverShape(view.query), ids)
        const action = set({
          ...view,
          status: 'applied',
          decision: 'accepted',
          decided_at: now(),
          stamp: stampOf(ids.length),
        })
        return { action, result }
      }),
    /** ``PATCH .../plan``: values changed, steps removed, before the start; never a new step. */
    plan: (id: number, edit: PlanEdit) =>
      step<ModelActionView>(id, (view) => {
        if (view.status !== 'proposed' || !isPlan(view) || started(view))
          return wrongState(view, 'plan')
        const steps = view.steps.map((s) => ({ ...s }))
        const at = (position: number) =>
          steps.find((s) => s.position === position && s.status !== 'removed')
        const invalid = (message: string, details: Record<string, unknown>) =>
          fail('invalid_query', message, details, 422)
        for (const position of edit.remove)
          if (!at(position)) return invalid(`No step ${position} to remove.`, { position })
        for (const change of edit.change) {
          const target = at(change.position)
          if (!target || edit.remove.includes(change.position))
            return invalid(`No step ${change.position} to change.`, { position: change.position })
          if (!sameNames(target.arguments, change.arguments))
            return invalid(`Step ${change.position}: only values may change.`, {
              position: change.position,
            })
        }
        const removed = new Set(edit.remove)
        const left = steps.filter((s) => s.status !== 'removed' && !removed.has(s.position))
        if (left.length === 0) return invalid('A plan needs one step at least.', {})
        for (const s of left) {
          const reads = readsOf(s.arguments).find((r) => removed.has(r))
          if (reads !== undefined)
            return invalid(`Step ${s.position} reads the result of step ${reads}.`, {
              position: s.position,
              reads,
            })
        }
        for (const s of steps) if (removed.has(s.position)) s.status = 'removed'
        for (const change of edit.change) {
          const target = at(change.position)
          if (target) target.arguments = change.arguments
        }
        return set({ ...view, steps })
      }),
  }
}

export type ModelServer = ReturnType<typeof modelServer>

/** The decisions a status may carry (store.py ``DECIDED``). */
export const DECIDED: Partial<Record<ActionStatus, readonly Decision[]>> = {
  applied: ['accepted', 'adjusted', 'auto', 'proposal_only'],
  rejected: ['rejected'],
  superseded: ['superseded', 'proposal_only'],
  undone: ['accepted', 'auto'],
}
