// The fake API's model records keep the contract (plan WP62): every record built
// from the fixture is valid against the backend's own OpenAPI schema.
import Ajv2020 from 'ajv/dist/2020'
import { describe, expect, test } from 'vitest'
import openapi from '../../openapi.json'
import {
  actionView,
  isFakeError,
  modelCase,
  modelServer,
  promptRoutes,
  RECORD_CASES,
  type CaseId,
} from './model-mocks'
import type { ModelActionView } from '../api/client'
import { ENFORCEMENT } from '../model/enforcement'
import { decideRoute } from './prompt-panel'
import { assertValidQuery } from './schema'

const ajv = new Ajv2020({ strict: false, allErrors: true })
ajv.addSchema(openapi, 'openapi')
const found = ajv.getSchema('openapi#/components/schemas/ModelActionView')
if (!found) throw new Error('ModelActionView is missing from openapi.json')
const validView = found
const schema = (name: string) => {
  const validate = ajv.getSchema(`openapi#/components/schemas/${name}`)
  if (!validate) throw new Error(`${name} is missing from openapi.json`)
  return validate
}
const LEVELS = ['Assistenz', 'Prüfen', 'Teilautonom', 'Automatisch'] as const
/** An answer whose cells are all ``auto``: approved with enforcement, else a proposal (P1). */
const AUTO = ENFORCEMENT ? 'approved' : 'proposed'

test.each(RECORD_CASES as CaseId[])('%s is a valid record at every level', (id) => {
  for (const level of LEVELS) {
    const view = actionView(id, {}, level)
    expect(validView(view), JSON.stringify(validView.errors?.slice(0, 3))).toBe(true)
    if (view.query) assertValidQuery(view.query)
    // A decision exactly for the final states, with its time.
    expect(view.decision !== null).toBe(['failed', 'aborted'].includes(view.status))
    expect(view.decided_at !== null).toBe(view.decision !== null)
  }
})

test('cases refused before any model call have no record', () => {
  expect(() => actionView('quota_exceeded')).toThrow(/before any record/)
  expect(RECORD_CASES).not.toContain('stale_reference')
})

test('the level decides between a proposal and an auto answer', () => {
  expect(actionView('reference').governance).toEqual({
    classes: ['query', 'spatial'],
    cell: 'approve',
    needs_approval: ['query', 'spatial'],
    off: [],
  })
  expect(actionView('reference', {}, 'Automatisch').status).toBe(AUTO)
  expect(actionView('reference', {}, 'Assistenz').governance?.off).toEqual(['query', 'spatial'])
  // Not listed for the case: derived from the cell, as the backend will.
  expect(modelCase('follow_up').expect.status).not.toHaveProperty('Automatisch')
  expect(actionView('follow_up', {}, 'Automatisch').status).toBe(AUTO)
})

test('enforcement is on (E2.4): an all-auto answer arrives approved, off parts only propose', () => {
  expect(ENFORCEMENT).toBe(true)
  expect(actionView('reference', {}, 'Teilautonom')).toMatchObject({
    status: 'approved',
    governance: { cell: 'auto', off: [] },
  })
  expect(actionView('reference', {}, 'Assistenz')).toMatchObject({
    status: 'proposed',
    governance: { cell: 'off' },
  })
})

describe('the fake enforcement server keeps the contract (WP70, store.py)', () => {
  const code = (value: unknown) => (isFakeError(value) ? [value.status, value.body.code] : null)

  test('approve, then execute once: ExecuteResponse; a replay is already_decided', () => {
    const view = actionView('reference')
    const server = modelServer([view])
    // Only an approved record runs.
    expect(code(server.execute(view.id))).toEqual([409, 'not_approved'])
    expect(server.approve(view.id)).toMatchObject({ status: 'approved', decision: null })
    expect(code(server.approve(view.id))).toEqual([409, 'not_approved'])
    const response = server.execute(view.id)
    const valid = schema('ExecuteResponse')
    expect(valid(response), JSON.stringify(valid.errors?.slice(0, 3))).toBe(true)
    expect(response).toMatchObject({ action: { status: 'applied', decision: 'accepted' } })
    expect(code(server.execute(view.id))).toEqual([409, 'already_decided'])
    expect(code(server.reject(view.id, null))).toEqual([409, 'already_decided'])
  })

  test('an auto answer runs without approve and is decided auto', () => {
    const view = actionView('reference', {}, 'Teilautonom')
    expect(modelServer([view]).execute(view.id)).toMatchObject({ action: { decision: 'auto' } })
  })

  test('approve and preview with an off class: class_not_allowed', () => {
    const view = actionView('reference', {}, 'Assistenz')
    const server = modelServer([view])
    expect(server.approve(view.id)).toMatchObject({
      status: 409,
      body: { code: 'class_not_allowed', details: { part: 'query', level: 'Assistenz' } },
    })
    expect(code(server.preview(view.id))).toEqual([409, 'class_not_allowed'])
    expect(server.record(view.id)?.status).toBe('proposed')
  })

  test('preview: count, total and ids; the status stays, previewed_at is set', () => {
    const view = actionView('reference')
    const server = modelServer([view])
    const preview = server.preview(view.id)
    expect(schema('ActionPreview')(preview)).toBe(true)
    expect(preview).toMatchObject({ count: 10, total: 137 })
    expect(server.record(view.id)?.status).toBe('proposed')
    // Naive UTC with microseconds, as the server writes it.
    expect(server.record(view.id)?.previewed_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}$/)
    // A token is refused (P2: an interactive session only).
    expect(code(server.preview(view.id, true))).toEqual([403, 'session_required'])
  })

  test('preview and execute check the status first, then off, then the stored query', () => {
    const offRejected = actionView(
      'reference',
      { id: 101, status: 'rejected', decision: 'rejected' },
      'Assistenz',
    )
    const noQuery = actionView('reference', { id: 102, query: null })
    const offApproved = actionView('reference', { id: 103, status: 'approved' }, 'Assistenz')
    const server = modelServer([offRejected, noQuery, offApproved])
    expect(code(server.preview(offRejected.id))).toEqual([409, 'already_decided'])
    expect(code(server.preview(noQuery.id))).toEqual([409, 'not_approved'])
    expect(code(server.execute(offApproved.id))).toEqual([409, 'class_not_allowed'])
    expect(server.record(offApproved.id)?.status).toBe('approved')
  })

  test('reject keeps the reason; only a proposal is rejected', () => {
    const view = actionView('reference')
    const server = modelServer([view])
    const rejected = server.reject(view.id, 'wrong_layer')
    expect(validView(rejected)).toBe(true)
    expect(rejected).toMatchObject({
      status: 'rejected',
      decision: 'rejected',
      reject_reason: 'wrong_layer',
    })
    expect(code(server.approve(view.id))).toEqual([409, 'already_decided'])
  })

  test('undo: the last model change only, never after touched, never twice', () => {
    const first = actionView('reference', {}, 'Teilautonom')
    const second = actionView(
      'follow_up',
      { status: 'approved', governance: first.governance },
      'Teilautonom',
    )
    const server = modelServer([first, second])
    server.execute(first.id)
    server.execute(second.id)
    expect(code(server.undo(first.id))).toEqual([409, 'nothing_to_undo'])
    server.touched(second.id)
    expect(server.undo(second.id)).toMatchObject({
      status: 409,
      body: { code: 'undo_blocked', details: { id: second.id } },
    })
    // touched is judged before "latest", as the server does.
    server.touched(first.id)
    expect(code(server.undo(first.id))).toEqual([409, 'undo_blocked'])
    // touched only for an applied change.
    const proposed = actionView('reference')
    expect(code(modelServer([proposed]).touched(proposed.id))).toEqual([409, 'nothing_to_undo'])

    const fresh = modelServer([first])
    expect(code(fresh.undo(first.id))).toEqual([409, 'nothing_to_undo'])
    fresh.execute(first.id)
    const undone = fresh.undo(first.id)
    expect(validView(undone)).toBe(true)
    expect(undone).toMatchObject({ status: 'undone', decision: 'auto' })
    expect(code(fresh.undo(first.id))).toEqual([409, 'already_decided'])
  })

  test('decide: adjusted names its query and is never by hand', () => {
    const view = actionView('reference')
    const server = modelServer([view])
    const byHand = { decision: 'adjusted' as const, applied_by_hand: true, query: view.query }
    expect(code(server.decide(view.id, byHand))).toEqual([400, 'bad_request'])
    expect(code(server.decide(view.id, { decision: 'adjusted' }))).toEqual([400, 'bad_request'])
    expect(server.decide(view.id, { decision: 'adjusted', query: view.query })).toMatchObject({
      status: 'applied',
      decision: 'adjusted',
      applied_by_hand: false,
    })
  })
})

test('the fake decide takes a proposal once, as the server does', async () => {
  const post = (status?: ModelActionView['status']) =>
    Object.values(decideRoute(3, status))[0] as (init: RequestInit) => Response
  const body = { body: JSON.stringify({ decision: 'proposal_only', applied_by_hand: true }) }
  const answer = async (response: Response) => [response.status, await response.json()]
  const once = post()
  expect(await answer(once(body))).toMatchObject([
    200,
    { status: 'applied', decision: 'proposal_only' },
  ])
  expect(await answer(once(body))).toMatchObject([409, { code: 'already_decided' }])
  // Not there yet: thinking, or approved (an auto answer): not_approved, as WP70 answers.
  for (const early of ['thinking', 'approved'] as const)
    expect(await answer(post(early)(body))).toMatchObject([409, { code: 'not_approved' }])
  // Decided or final: already_decided.
  for (const final of ['answered', 'rejected', 'applied', 'superseded'] as const)
    expect(await answer(post(final)(body))).toMatchObject([409, { code: 'already_decided' }])
})

test('times are naive UTC, as the server writes them', () => {
  const view = actionView('aborted')
  for (const time of [view.created_at, view.decided_at])
    expect(time).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/)
})

test('a refusal keeps its code and shows no query', () => {
  const view = actionView('limit_exceeded')
  expect(view.refusal).toMatchObject({ code: 'limit_exceeded', details: { value: 10, max: 8 } })
  expect(view.query).toBeNull()
})

test('follow-ups point at their parent with the reference the server derives', () => {
  expect(actionView('follow_up').parent_action_id).toBe(actionView('reference').id)
  expect(actionView('follow_up').reference).toBe('last_answer')
  expect(actionView('follow_up_hand_edited').reference).toBe('hand_edited')
})

test('the prompt answers 202 thinking; polling brings the answer (P7)', async () => {
  const routes = promptRoutes('clarification')
  const post = routes['POST /api/model/prompt'] as () => Response
  const response = post()
  expect(response.status).toBe(202)
  const thinking = (await response.json()) as ModelActionView
  expect(thinking).toMatchObject({ status: 'thinking', answer: null })
  expect(validView(thinking)).toBe(true)
  const answered = routes[`GET /api/model/actions/${thinking.id}`] as ModelActionView
  expect(answered).toMatchObject({ status: 'answered', answer: { kind: 'clarification' } })
})

test('a chain is governed by its steps: approve at Prüfen, proposal only at Assistenz', () => {
  expect(actionView('chain_reference').governance?.cell).toBe('approve')
  expect(actionView('chain_reference', {}, 'Assistenz').governance?.cell).toBe('off')
  expect(actionView('chain_reference', {}, 'Automatisch').status).toBe(AUTO)
})
