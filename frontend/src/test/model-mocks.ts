// Modus B as the fake API answers it (plan WP62), built from the contract
// fixture the backend and e2e use too (schema/model-cases/v1.json): a case's
// answer and expectation become the action record the backend will return.
import fixture from '../../../schema/model-cases/v1.json'
import type {
  ActionStatus,
  Decision,
  Governance,
  ModelActionView,
  ModelAnswer,
  OpClass,
  QueryObject,
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
  if (typeof status === 'string') return status as ActionStatus
  const listed = (status as Partial<Record<LevelName, ActionStatus>>)[levelName]
  return listed ?? (governance(c, levelName)?.cell === 'auto' ? 'approved' : 'proposed')
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
  return {
    id: fixture.cases.indexOf(c) + 1,
    account: 'admin',
    created_at: '2026-10-10T14:05:00Z',
    decided_at: decision ? '2026-10-10T14:05:06Z' : null,
    prompt: c.prompt,
    approach: c.approach as ModelActionView['approach'],
    status,
    decision,
    reject_reason: null,
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
    governance: refused ? null : governance(c, levelName),
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
