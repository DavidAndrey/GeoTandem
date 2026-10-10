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
  OpClass,
  QueryObject,
  QueryResult,
  RejectReason,
} from '../api/client'
import { ENFORCEMENT } from '../model/enforcement'

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
// Before enforcement every level only proposes (P1): the E2.3 server sends
// ``proposed`` where the fixture, written for E2.4, says ``approved``.
function statusOf(c: Case, levelName: LevelName, enforcement = ENFORCEMENT): ActionStatus {
  const status: unknown = 'status' in c.expect ? c.expect.status : undefined
  if (status === undefined) throw new Error(`case '${c.id}' is refused before any record exists`)
  const listed =
    typeof status === 'string'
      ? (status as ActionStatus)
      : ((status as Partial<Record<LevelName, ActionStatus>>)[levelName] ??
        (governance(c, levelName)?.cell === 'auto' ? 'approved' : 'proposed'))
  return listed === 'approved' && !enforcement ? 'proposed' : listed
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
    steps: [],
    replans: 0,
    stop_reason: null,
    stamp: null,
    latency_ms: 6000,
    ...patch,
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
//   account's latest model change (else ``nothing_to_undo``).
// - ``touched``: ``applied`` only (else 409 ``nothing_to_undo``); the record
//   is answered unchanged, the first report stays.
// - ``decide``: ``proposal_only`` only for a proposal with an ``off`` class,
//   else 409 ``not_approved`` (WP71).
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

/**
 * The model routes of one account as the server answers them: one store for
 * all records, so "the last model change" spans records as on the server.
 * Each step returns its answer or a ``FakeError``.
 */
export function modelServer(
  views: readonly ModelActionView[],
  preview: ActionPreview = { count: 10, total: 137, ids: REFERENCE_IDS },
) {
  const records = new Map(views.map((v) => [v.id, v]))
  const touched = new Map<number, string>()
  let latest: number | null = null
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
  const nothingToUndo = (view: ModelActionView, why: string): FakeError =>
    fail('nothing_to_undo', `Model action ${view.id} cannot be undone: ${why}.`, {
      id: view.id,
      status: view.status,
      decision: view.decision,
    })
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
        return offClass(view) ?? set({ ...view, status: 'approved' })
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
        latest = view.id
        return { action, result }
      }),
    undo: (id: number) =>
      step<ModelActionView>(id, (view) => {
        if (view.status === 'undone') return wrongState(view, 'undo')
        if (view.status !== 'applied')
          return nothingToUndo(view, `it changed nothing (${view.status})`)
        if (view.decision !== 'accepted' && view.decision !== 'auto')
          return nothingToUndo(view, 'it was applied by the user, not by the model')
        const at = touched.get(view.id)
        if (at)
          return fail(
            'undo_blocked',
            `Model action ${view.id} cannot be undone: the analysis was changed by hand after it.`,
            { id: view.id, touched_at: at },
          )
        if (latest !== view.id)
          return nothingToUndo(view, `a later model change (${latest}) came after it`)
        return set({ ...view, status: 'undone', undone_at: now() })
      }),
    touched: (id: number) =>
      step<ModelActionView>(id, (view) => {
        if (view.status !== 'applied')
          return nothingToUndo(view, `it is no applied change (${view.status})`)
        if (!touched.has(view.id)) touched.set(view.id, now())
        return view
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
        // WP71: ``proposal_only`` belongs to a level with ``off`` parts (store.py ``decide``).
        if (body.decision === 'proposal_only' && !(view.governance?.off ?? []).length)
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
