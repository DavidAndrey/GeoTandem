// Modus B as the fake API answers it (plan WP62), built from the contract
// fixture the backend and e2e use too (schema/model-cases/v1.json): a case's
// answer and expectation become the action record the backend will return.
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
  ModelView,
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
    // A chain's run time so far (WP75 ``run_ms``, 0 until it runs); none for a direct query.
    run_ms: c.approach === 'chain' && !refused ? 0 : null,
    ...patch,
  }
}

type PlanAnswer = Extract<ModelAnswer, { kind: 'plan' }>
export type PlannedStep = PlanAnswer['steps'][number]
type Matrix = ModelActionView['level']['matrix']
type Json = Record<string, unknown>

/** Each chain tool's own class (``tools/chain.py``, H2). */
const TOOL_CLASS: Record<string, OpClass> = {
  filter: 'query',
  buffer: 'derive',
  within: 'spatial',
  outside: 'spatial',
  intersects: 'spatial',
  near: 'spatial',
}

const CLASS_ORDER: readonly OpClass[] = ['catalog', 'query', 'spatial', 'derive', 'display']

/** The argument a tool names its target step by (``tools/chain.py`` inputs). */
const TARGET: Record<string, string> = {
  within: 'in',
  outside: 'in',
  intersects: 'with',
  near: 'to',
}

/** The earlier steps a step names, by argument (``plan.py`` ``reads``). */
function readsOf(step: { tool: string; arguments: Json }): [string, number][] {
  const keys = ['of', ...(TARGET[step.tool] ? [TARGET[step.tool] as string] : [])]
  return keys.flatMap((key) => {
    const value = step.arguments[key]
    return typeof value === 'number' ? [[key, value] as [string, number]] : []
  })
}

/** ``conjoin`` of ``tools/chain.py``: one flat ``and``, never one of a single argument. */
function conjoin(first: unknown, then: unknown): unknown {
  const flat = (c: unknown): unknown[] =>
    c === undefined || c === null
      ? []
      : (c as Json).op === 'and'
        ? ((c as Json).args as unknown[]).flatMap(flat)
        : [c]
  const parts = [...flat(first), ...flat(then)]
  return parts.length === 0 ? undefined : parts.length === 1 ? parts[0] : { op: 'and', args: parts }
}

/** ``base`` with ``where`` (and ``extra``) as a step narrows it; compact, as the server writes it. */
function narrowed(base: Json, where: unknown, extra: Json = {}): Json {
  const rest = Object.fromEntries(Object.entries(base).filter(([key]) => key !== 'where'))
  const condition = conjoin(base.where, where)
  return { ...rest, ...(condition === undefined ? {} : { where: condition }), ...extra }
}

/**
 * A step's query object as the chain's tools build it (``tools/chain.py``)
 * from the earlier steps' ones: a filter narrows a layer or a step, a buffer
 * adds ``buffer``, a spatial step relates ``of`` to its target (``dwithin``
 * for a buffer). The fixture's conditions are attribute conditions only.
 */
function stepQuery(step: PlannedStep, earlier: ReadonlyMap<number, Json>): Json {
  const args = step.arguments as Json
  const base = (): Json =>
    typeof args.of === 'number'
      ? (earlier.get(args.of) ?? {})
      : { schema_version: '2', source: args.layer, output: 'map' }
  if (step.tool === 'filter') return narrowed(base(), args.where)
  if (step.tool === 'buffer')
    return narrowed(base(), args.where, { buffer: { distance_m: args.distance_m } })
  const target = earlier.get(args[TARGET[step.tool] ?? 'in'] as number) ?? {}
  const buffer = target.buffer as { distance_m: number } | undefined
  const filter = target.where === undefined ? {} : { where: target.where }
  const relation =
    buffer || step.tool === 'near'
      ? {
          op: 'related',
          layer: target.source,
          predicate: 'dwithin',
          distance_m: buffer?.distance_m ?? args.distance_m,
          ...filter,
        }
      : {
          op: 'related',
          layer: target.source,
          predicate: step.tool === 'intersects' ? 'intersects' : 'within',
          ...filter,
        }
  return narrowed(base(), step.tool === 'outside' ? { op: 'not', arg: relation } : relation)
}

/** A step's classes (``plan.py`` ``step_classes``): its tool's and its ``where``'s (H4). */
function stepClasses(step: PlannedStep): OpClass[] {
  const own = new Set<OpClass>([TOOL_CLASS[step.tool] ?? 'query'])
  if ((step.arguments as Json).where) own.add('query')
  return CLASS_ORDER.filter((k) => own.has(k))
}

const strictest = (matrix: Matrix, classes: readonly OpClass[]): StepView['cell'] => {
  const cells = classes.map((k) => matrix[k])
  return cells.includes('off') ? 'off' : cells.includes('approve') ? 'approve' : 'auto'
}

/**
 * Planned steps as the server stores them (WP75, ``new_step``): each with its
 * query object, its classes and its cell, the strictest of them at the level
 * as it was. ``earlier``: the queries of the steps they may name.
 */
function chainSteps(
  planned: readonly { position: number; step: PlannedStep }[],
  matrix: Matrix,
  earlier: ReadonlyMap<number, Json> = new Map(),
  revised = false,
): StepView[] {
  const known = new Map(earlier)
  return planned.map(({ position, step }) => {
    const query = stepQuery(step, known)
    known.set(position, query)
    const classes = stepClasses(step)
    return {
      position,
      text: step.text,
      tool: step.tool,
      arguments: step.arguments,
      classes,
      cell: strictest(matrix, classes),
      status: 'planned',
      revised,
      hits: null,
      stamp: null,
      query: query as StepView['query'],
      model_view: null,
      duration_ms: null,
    }
  })
}

function planSteps(c: Case, levelName: LevelName): StepView[] {
  const plan = c.answer as unknown as PlanAnswer
  const placed = plan.steps.map((step, i) => ({ position: i + 1, step }))
  return chainSteps(placed, level(levelName).matrix)
}

/** The chain's governance (``chain_governance``): the union of its steps' classes (D1). */
function chainGovernance(steps: readonly StepView[], matrix: Matrix): Governance {
  const union = new Set(steps.filter((s) => s.status !== 'removed').flatMap((s) => s.classes))
  const classes = CLASS_ORDER.filter((k) => union.has(k))
  return {
    classes,
    cell: strictest(matrix, classes),
    needs_approval: classes.filter((k) => matrix[k] === 'approve'),
    off: classes.filter((k) => matrix[k] === 'off'),
  }
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
// As WP75's server answers (merged at a525297: model/service.py ``run``,
// ``abort``, ``edit_plan``, ``adopt`` and ``_Runner``; model/record/store.py
// ``approve``, ``reject``, ``halt``, ``revise``, ``stop``, ``_ended``,
// ``last_complete``; model/chain/plan.py ``edit_plan``, ``check_plan``,
// ``one_approval``; model/chain/ask.py ``ChainState.ran``):
// - ``approve``: ``proposed`` → ``approved``, decided over the whole plan as it
//   stands (every step not removed): no step ``auto`` (Prüfen) ⇒ every step
//   ahead (planned, waiting) is cleared, else the next one only; a cleared
//   step is ``planned`` again.
// - ``run`` (202): ``approved`` chains only; answers ``running`` with the steps
//   unchanged (``stop_reason`` and ``error`` cleared); may answer 409 ``busy``
//   {reason: running, id: the account's call in flight} (the script's
//   ``busy``) or 503 ``busy`` {reason: model_calls} (``busyCalls``). The steps then run back to back in the
//   background: a step runs when its cell is ``auto`` or an approval cleared
//   it, else the run halts before it (``proposed``, that step ``waiting``).
//   No background here: each poll runs ``pace`` steps (default: all of the
//   stretch); the one next in line then shows ``running``.
// - A step ends ``ok``, ``empty`` (0 hits) or ``error`` (``hits`` null), with
//   ``duration_ms`` and ``model_view`` carrying every key (null where unused).
//   After an ``error`` step, or an empty one before the last, a re-plan:
//   none left (``replans``) ⇒ ``limited``/``replan_limit``, ``error`` null;
//   the script's ``replanError`` ⇒ ``replan_limit`` with it (a connection
//   no longer available is found before the call: ``replans`` not raised);
//   no revision scripted ⇒ the model brought no plan ⇒ ``replan_limit``,
//   ``error`` null; a revision ending in a buffer (``not_representable``) or
//   with a class ``off`` (``class_not_allowed`` {part, step}) ⇒
//   ``replan_limit`` with that error.
//   A revision's steps start after the last step that ran; the steps ahead
//   and the removed ones after it are deleted, those that ran (an ``error``
//   one too) stay. Every step that ran counts: spent + new > ``steps`` ⇒
//   ``step_limit`` {step, value, max}. Then one approval over the whole plan
//   as it stands ⇒ ``proposed`` with no step ``waiting``; else the run goes
//   on. The record's ``answer`` stays the original plan.
// - Limits: only the **last** step beyond ``max_features`` fails (run.py
//   ``run_step``): ``error`` (code ``result_too_large``), ``limited`` with
//   ``error`` {code, message, details {step, value, max}}; an earlier step
//   beyond it is counted as any other. ``time_limit`` before a step: {step,
//   value (s), max}. A restart (or a failed run) ends ``limited``/
//   ``interrupted`` with the result's ``query`` but no stamp (store.py
//   ``close_stale``). ``run_ms`` grows by each step's duration.
// - The end (``done``, ``limited``): steps ahead or running ``skipped``; the
//   result is the last complete step (ok, empty) that is no buffer and within
//   ``max_features``: its query the record's ``query``, its stamp the
//   record's ``stamp`` and that step's, the only step with one. No such step
//   ⇒ both null.
// - ``abort``: ``thinking`` ⇒ ``aborted``. ``running`` with its run in flight
//   ⇒ answers ``running`` with ``stop_reason`` ``aborted``; the run finishes
//   the step that runs and ends ``limited``/``aborted`` (here: at the next
//   poll). ``running`` without a run (``lose``) ⇒ ``limited``/``aborted`` at once. Halted (``proposed``,
//   or ``approved`` and not running, after a step ran) ⇒ ``limited``/``aborted``
//   at once. A plan that never started ⇒ 409 ``not_approved``.
// - ``reject`` (and supersede) of a chain: its steps ahead and running ``skipped``.
// - ``adopt``: a token ⇒ 403 ``session_required``; every query slot taken ⇒
//   503 ``busy`` (``queriesBusy``); being adopted already ⇒ 409
//   ``already_decided`` (``claim``); ``done``/``limited`` only;
//   ``query`` null ⇒ 409 ``not_approved``; → ``applied``/``accepted`` at every
//   level, Automatisch included, with the stamp of the run as the user;
//   ``ExecuteResponse`` (the rows' ``query`` as a full dump).
// - ``PATCH .../plan``: a token ⇒ 403; ``proposed`` only (409), never a class
//   ``off`` (409 ``class_not_allowed``), not started (409 ``not_approved``); a
//   step changed twice ⇒ 422; then ``edit_plan``: no such step, changed and
//   removed, anything but a value changed, nothing left, a removed step that
//   a kept one reads ⇒ 422 ``invalid_query`` {step[, reads, part]}; the plan
//   checked whole: ending in a buffer ⇒ 422 ``not_representable`` {step,
//   part}. The steps get query, classes and cell anew, removed ones stay
//   ``removed``, every clearance goes, the governance anew.

/** What a run meets (``modelServer``'s ``script``); without one it runs through. */
export interface ChainScript {
  /** Hits by position; default ``CHAIN_HITS``. 0 makes the step ``empty``. */
  hits?: Record<number, number>
  /** Steps that fail, by position: an engine code (and the name it is about). */
  errors?: Record<number, { code: NonNullable<ModelView['code']>; part?: string }>
  /** The request's time runs out before the step at this position (``time_limit``). */
  timeLimit?: number
  /** The application restarts before the step at this position (``interrupted``). */
  interrupt?: number
  /** The revised steps of each re-plan in turn. */
  replans?: PlannedStep[][]
  /** The re-plan call fails with this error (``replan_limit``). */
  replanError?: { code: string; details?: Record<string, unknown> }
  /** Steps run per poll (default: the whole stretch at once). */
  pace?: number
  /** ``run`` answers 409 ``busy`` this many times first (the account's call in flight). */
  busy?: number
  /** ``run`` answers 503 ``busy`` this many times first (every model call taken). */
  busyCalls?: number
}

const CHAIN_CASE = modelCase('chain_reference')

const CHAIN_EXPECT = CHAIN_CASE.expect as { step_hits: number[]; step_ms: number[] }

/** Example step durations of the reference chain (contract fixture ``chain_reference``: 3.6 s in all). */
export const CHAIN_DURATIONS_MS: number[] = CHAIN_EXPECT.step_ms

/**
 * Hits of the reference chain's steps on the sample data (contract fixture
 * ``chain_reference``: 62, 37, 37, 37, then 10 of 137; the backend's tests pin the same).
 */
export const CHAIN_HITS: number[] = CHAIN_EXPECT.step_hits

const RAN: readonly StepView['status'][] = ['ok', 'empty', 'error']
const ahead = (s: StepView) => s.status === 'planned' || s.status === 'waiting'
const isPlan = (view: ModelActionView) => view.answer?.kind === 'plan'
/** A step ran, runs, or was skipped (store.py ``_started``). */
const started = (view: ModelActionView) =>
  view.steps.some((s) => [...RAN, 'running', 'skipped'].includes(s.status))
/** ``one_approval``: no step of the plan as it stands is ``auto``. */
const oneApproval = (steps: readonly StepView[]) =>
  !steps.some((s) => s.status !== 'removed' && s.cell === 'auto')

const stampOf = (count: number): NonNullable<StepView['stamp']> => ({
  count,
  ids_hash: 'sha256:ids',
  query_hash: 'sha256:query',
  data_versions: { schulen: 'v1' },
})

/** ``last_complete``: the last ok or empty step that is no buffer and within the limit. */
function adoptable(steps: readonly StepView[]): StepView | null {
  const complete = steps.filter(
    (s) => (s.status === 'ok' || s.status === 'empty') && !(s.query as Json | null)?.buffer,
  )
  const last = complete[complete.length - 1]
  return last && (last.hits ?? 0) <= MODEL_LIMITS.max_features ? last : null
}

const VALUE_KEYS = ['value', 'values', 'min', 'max', 'text', 'distance_m']

/** ``plan.py`` ``values_only``: ``after`` differs from ``before`` in values only. */
function valuesOnly(before: unknown, after: unknown, key = ''): boolean {
  if (VALUE_KEYS.includes(key)) return true
  if (Array.isArray(before))
    return (
      Array.isArray(after) &&
      before.length === after.length &&
      before.every((b, i) => valuesOnly(b, after[i], key))
    )
  if (typeof before === 'object' && before !== null) {
    if (typeof after !== 'object' || after === null || Array.isArray(after)) return false
    const left = before as Json
    const right = after as Json
    const keys = Object.keys(left)
    return (
      keys.length === Object.keys(right).length &&
      keys.every((k) => k in right && valuesOnly(left[k], right[k], k))
    )
  }
  return typeof before === typeof after && before === after
}

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
  /** Steps an approval cleared (store.py ``approved``), by record. */
  const cleared = new Map<number, Set<number>>()
  /** Records whose run is in flight (``ModelCalls.in_flight``). */
  const inFlight = new Set<number>()
  /** Records being adopted (``ModelCalls.claim``). */
  const claimed = new Set<number>()
  let held = false
  let queriesBusy = false
  let busy = script.busy ?? 0
  let busyCalls = script.busyCalls ?? 0
  const clearedOf = (id: number) => cleared.get(id) ?? new Set<number>()
  const chainError = (code: string, details: Record<string, unknown>) => ({
    code,
    message: `Stopped: ${code}.`,
    details,
  })
  /**
   * The run ended (store.py ``_ended``): the rest skipped, the result chosen
   * (``last_complete``) and, unless ``unstamped`` (a restart, an expiry), stamped.
   */
  const ended = (
    view: ModelActionView,
    steps: StepView[],
    fields: Partial<ModelActionView>,
    unstamped = false,
  ) => {
    for (const s of steps) if (ahead(s) || s.status === 'running') s.status = 'skipped'
    const result = adoptable(steps)
    const stamp = result && !unstamped ? stampOf(result.hits ?? 0) : null
    if (result && stamp) result.stamp = stamp
    inFlight.delete(view.id)
    return {
      ...view,
      ...fields,
      steps,
      query: (result?.query ?? null) as QueryObject | null,
      stamp,
    }
  }
  const finishRun = (view: ModelActionView, steps: StepView[]) =>
    ended(view, steps, { status: 'done', stop_reason: null })
  const stopRun = (
    view: ModelActionView,
    steps: StepView[],
    reason: StopReason,
    error: ModelActionView['error'] = null,
  ) =>
    ended(view, steps, { status: 'limited', stop_reason: reason, error }, reason === 'interrupted')
  /** The run waits for approval (store.py ``halt``); the run gives its place back. */
  const halted = (view: ModelActionView, steps: StepView[]): ModelActionView => {
    inFlight.delete(view.id)
    return { ...view, steps, status: 'proposed' }
  }
  /**
   * One step as it ran (``run_step``): its outcome, count, view and duration;
   * the ``last`` step beyond ``max_features`` fails with ``result_too_large``
   * (an earlier one is counted as any other). ``true``: the run stops there.
   */
  const ran = (s: StepView, last: boolean): number | null => {
    s.duration_ms = CHAIN_DURATIONS_MS[s.position - 1] ?? 500
    const failed = script.errors?.[s.position]
    const hits = script.hits?.[s.position] ?? CHAIN_HITS[s.position - 1] ?? 1
    const tooLarge = last && hits > MODEL_LIMITS.max_features
    if (failed || tooLarge) {
      s.status = 'error'
      s.hits = null
      s.model_view = {
        outcome: 'error',
        code: failed?.code ?? 'result_too_large',
        part: failed?.part ?? null,
        empty: null,
        count: null,
      }
      return tooLarge ? hits : null
    }
    s.status = hits === 0 ? 'empty' : 'ok'
    s.hits = hits
    s.model_view = { outcome: 'ok', code: null, part: null, empty: hits === 0, count: hits }
    return null
  }
  /**
   * A re-plan after the step at ``last`` (P4, ``_Runner.replan``): the
   * record with its revised steps and whether it halts, or the run stopped.
   */
  const replan = (
    view: ModelActionView,
    steps: StepView[],
    last: number,
  ): { view: ModelActionView; steps: StepView[]; halt: boolean } | { stopped: ModelActionView } => {
    if (view.replans >= MODEL_LIMITS.replans)
      return { stopped: stopRun(view, steps, 'replan_limit') }
    if (script.replanError?.code === 'connection_not_available') {
      // Checked before the call (``_replan_endpoint``): no re-plan is counted.
      const { code, details = {} } = script.replanError
      return { stopped: stopRun(view, steps, 'replan_limit', chainError(code, details)) }
    }
    const asked = { ...view, replans: view.replans + 1 }
    if (script.replanError) {
      const { code, details = {} } = script.replanError
      return { stopped: stopRun(asked, steps, 'replan_limit', chainError(code, details)) }
    }
    const revision = script.replans?.[view.replans]
    if (!revision) return { stopped: stopRun(asked, steps, 'replan_limit') }
    const spent = steps.filter((s) => RAN.includes(s.status)).length
    const total = spent + revision.length
    if (total > MODEL_LIMITS.steps) {
      const step = last + 1 + Math.max(MODEL_LIMITS.steps - spent, 0)
      const error = chainError('step_limit', { step, value: total, max: MODEL_LIMITS.steps })
      return { stopped: stopRun(asked, steps, 'step_limit', error) }
    }
    const kept = steps.filter((s) => !(s.position > last && (ahead(s) || s.status === 'removed')))
    const earlier = new Map(
      kept
        .filter((s) => s.status === 'ok' || s.status === 'empty')
        .map((s) => [s.position, s.query as Json]),
    )
    const placed = revision.map((step, i) => ({ position: last + 1 + i, step }))
    const fresh = chainSteps(placed, view.level.matrix, earlier, true)
    // The plan check (``check_plan``): a chain does not end in a buffer.
    const end = fresh[fresh.length - 1]
    if (end && (end.query as Json | null)?.buffer) {
      const error = chainError('not_representable', { step: end.position, part: 'buffer' })
      return { stopped: stopRun(asked, steps, 'replan_limit', error) }
    }
    // Governed again over what ran and the new steps (``revised``): no class ``off``.
    const ranSteps = kept.filter((s) => RAN.includes(s.status))
    const rules = chainGovernance([...ranSteps, ...fresh], view.level.matrix)
    const off = rules.off[0]
    if (off) {
      const step = fresh.find((s) => s.classes.includes(off))?.position
      const error = chainError('class_not_allowed', { part: off, step })
      return { stopped: stopRun(asked, steps, 'replan_limit', error) }
    }
    const all = [...kept, ...fresh]
    cleared.set(view.id, new Set([...clearedOf(view.id)].filter((p) => p <= last)))
    const revised = { ...asked, governance: rules }
    return { view: revised, steps: all, halt: oneApproval(all) }
  }
  /** The run in the background (``_Runner.go``), ``pace`` steps of it at most. */
  const go = (view: ModelActionView, pace: number): ModelActionView => {
    let current = view
    let steps = view.steps.map((s) => ({ ...s }))
    for (let done = 0; ;) {
      const running = steps.find((s) => s.status === 'running')
      const next = running ?? steps.find(ahead)
      if (!next) return finishRun(current, steps)
      if (!running) {
        // Before a step: an abort, a restart, the time limit, a halt for approval (P4).
        if (current.stop_reason === 'aborted') return stopRun(current, steps, 'aborted')
        if (script.interrupt === next.position) return stopRun(current, steps, 'interrupted')
        if (script.timeLimit === next.position) {
          const details = { step: next.position, value: MODEL_LIMITS.chain_s + 1 }
          const error = chainError('time_limit', { ...details, max: MODEL_LIMITS.chain_s })
          return stopRun(current, steps, 'time_limit', error)
        }
        if (next.cell !== 'auto' && !clearedOf(view.id).has(next.position))
          return halted(
            current,
            steps.map((s) => (s === next ? { ...s, status: 'waiting' } : s)),
          )
        next.status = 'running'
        if (done >= pace) return { ...current, steps }
      }
      done += 1
      const plan = steps.filter((s) => s.status !== 'removed')
      const last = next.position === plan[plan.length - 1]?.position
      const tooLarge = ran(next, last)
      // ``run_ms``: the run's time so far, written as each step ends.
      current = { ...current, run_ms: (current.run_ms ?? 0) + (next.duration_ms ?? 0) }
      if (tooLarge !== null) {
        const details = { step: next.position, value: tooLarge, max: MODEL_LIMITS.max_features }
        return stopRun(current, steps, 'result_too_large', chainError('result_too_large', details))
      }
      if (next.status === 'ok' || (next.status === 'empty' && last)) {
        if (last) return finishRun(current, steps)
        continue
      }
      // An error, or an empty step before the last: a re-plan (``ChainState.ran``).
      const after = replan(current, steps, next.position)
      if ('stopped' in after) return after.stopped
      current = after.view
      steps = after.steps
      if (after.halt) return halted(current, steps)
    }
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
        if (!isPlan(view)) return set({ ...view, status: 'approved' })
        // Over the whole plan as it stands: one approval (Prüfen) or the next step only.
        const steps = view.steps.map((s) => ({ ...s }))
        const waiting = steps.filter(ahead)
        const done = clearedOf(view.id)
        for (const s of oneApproval(steps) ? waiting : waiting.slice(0, 1)) {
          done.add(s.position)
          s.status = 'planned'
        }
        cleared.set(view.id, done)
        return set({ ...view, status: 'approved', steps })
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
              // A chain's steps ahead never run (store.py ``_end_steps``).
              steps: view.steps.map((s) =>
                ahead(s) || s.status === 'running' ? { ...s, status: 'skipped' } : s,
              ),
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
    /** ``GET .../actions/{id}``: the record; a running chain further by ``pace`` steps (unless held). */
    poll: (id: number) =>
      step<ModelActionView>(id, (view) =>
        view.status === 'running' && !held ? set(go(view, script.pace ?? Infinity)) : view,
      ),
    /** Holds the run where it is (``true``) or lets it go on. */
    hold: (on: boolean) => {
      held = on
    },
    /** The run is gone (given up), the record still ``running``. */
    lose: (id: number) => {
      inFlight.delete(id)
    },
    /** Another adopt of the record is under way (``ModelCalls.claim``). */
    claim: (id: number) => {
      claimed.add(id)
    },
    /** Every query slot is taken (``QueriesBusy``, 503). */
    queriesBusy: (on: boolean) => {
      queriesBusy = on
    },
    /** ``POST .../run`` (202): an approved chain runs on; its steps unchanged until polled. */
    run: (id: number) =>
      step<ModelActionView>(id, (view) => {
        if (view.status !== 'approved') return wrongState(view, 'run')
        const refused = offClass(view)
        if (refused) return refused
        if (!isPlan(view))
          return fail('not_approved', `Model action ${id} is a direct query.`, {
            id,
            status: view.status,
          })
        if (busy > 0) {
          busy -= 1
          // The account's call in flight: here the run that halted, giving its place back.
          return fail('busy', `The account's prompt ${id} is still being answered.`, {
            reason: 'running',
            id,
          })
        }
        if (busyCalls > 0) {
          busyCalls -= 1
          return fail(
            'busy',
            'Too many model requests are running at once.',
            { reason: 'model_calls' },
            503,
          )
        }
        inFlight.add(id)
        return set({ ...view, status: 'running', stop_reason: null, error: null })
      }),
    /** ``POST .../abort`` (``abort``, ``_abort_chain``). */
    abort: (id: number) =>
      step<ModelActionView>(id, (view) => {
        if (view.status === 'thinking')
          return set({ ...view, status: 'aborted', decision: 'aborted', decided_at: now() })
        if (!isPlan(view)) return wrongState(view, 'abort')
        if (view.status === 'running' && inFlight.has(id))
          return set({ ...view, stop_reason: 'aborted' })
        if (view.status === 'running')
          return set(
            stopRun(
              view,
              view.steps.map((s) => ({ ...s })),
              'aborted',
            ),
          )
        const waits = view.status === 'proposed' || view.status === 'approved'
        if (!waits || !started(view)) return wrongState(view, 'abort')
        const steps = view.steps.map((s) => ({ ...s }))
        return set(stopRun(view, steps, 'aborted'))
      }),
    /** ``POST .../adopt``: a ``done`` or ``limited`` chain's result becomes the analysis. */
    adopt: (id: number, token = false) =>
      token
        ? fail('session_required', 'Only an interactive session may do this.', {}, 403)
        : queriesBusy
          ? fail('busy', 'Too many queries are running at the same time.', {}, 503)
          : step<ExecuteResponse>(id, (view) => {
              if (view.status !== 'done' && view.status !== 'limited')
                return wrongState(view, 'adopt')
              if (claimed.has(id))
                return fail('already_decided', `Model action ${id} is being adopted already.`, {
                  id,
                  status: 'done',
                })
              const refused = offClass(view)
              if (refused) return refused
              if (!isPlan(view) || !view.query)
                return fail(
                  'not_approved',
                  `Model action ${view.id} has no complete result to adopt.`,
                  { id: view.id, status: view.status },
                )
              const count = view.stamp?.count ?? 0
              const ids =
                view.status === 'done'
                  ? preview.ids
                  : Array.from({ length: count }, (_, i) => i + 1)
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
    /** ``PATCH .../plan`` (``edit_plan``): values and removals before the start; never a new step. */
    plan: (id: number, edit: PlanEdit, token = false) =>
      token
        ? fail('session_required', 'Only an interactive session may do this.', {}, 403)
        : step<ModelActionView>(id, (view) => {
            if (view.status !== 'proposed') return wrongState(view, 'plan')
            const refused = offClass(view)
            if (refused) return refused
            if (
              !isPlan(view) ||
              view.steps.some((s) => s.status !== 'planned' && s.status !== 'removed')
            )
              return fail(
                'not_approved',
                `Model action ${id} has started; its plan stays as it ran.`,
                {
                  id,
                  status: view.status,
                },
              )
            const invalid = (message: string, details: Record<string, unknown> = {}) =>
              fail('invalid_query', message, details, 422)
            const changes = new Map(edit.change.map((c) => [c.position, c.arguments as Json]))
            if (changes.size !== edit.change.length)
              return invalid('A step is changed once per edit.')
            const live = view.steps.filter((s) => s.status !== 'removed')
            const at = new Map(live.map((s) => [s.position, s]))
            for (const position of [...changes.keys(), ...edit.remove])
              if (!at.has(position))
                return invalid(`There is no step ${position} in the plan.`, { step: position })
            for (const [position, args] of changes) {
              if (edit.remove.includes(position))
                return invalid(`Step ${position} is changed and removed.`, { step: position })
              if (!valuesOnly(at.get(position)?.arguments, args))
                return invalid(`Step ${position}: only values may change, every name stays.`, {
                  step: position,
                })
            }
            const kept = live
              .filter((s) => !edit.remove.includes(s.position))
              .map((s) => ({
                position: s.position,
                step: {
                  text: s.text,
                  tool: s.tool,
                  arguments: changes.get(s.position) ?? s.arguments,
                },
              }))
            if (kept.length === 0) return invalid('A plan keeps one step at least.')
            for (const { position, step: planned } of kept)
              for (const [key, reads] of readsOf(planned))
                if (edit.remove.includes(reads))
                  return invalid(
                    `Step ${position} reads the result of step ${reads} ('${key}'), which is removed.`,
                    { step: position, reads, part: key },
                  )
            // The plan checked whole (``check_plan``): it does not end in a buffer.
            const checked = chainSteps(kept, view.level.matrix)
            const end = checked[checked.length - 1]
            if (end && (end.query as Json | null)?.buffer)
              return fail(
                'not_representable',
                `Step ${end.position}: a chain does not end in a buffer; the controls cannot show it.`,
                { step: end.position, part: 'buffer' },
                422,
              )
            const by = new Map(checked.map((s) => [s.position, s]))
            const steps = view.steps.map(
              (s) => by.get(s.position) ?? { ...s, status: 'removed' as const },
            )
            cleared.delete(id)
            return set({ ...view, steps, governance: chainGovernance(steps, view.level.matrix) })
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
