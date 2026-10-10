// The fake API's model records keep the contract (plan WP62): every record built
// from the fixture is valid against the backend's own OpenAPI schema.
import Ajv2020 from 'ajv/dist/2020'
import { expect, test } from 'vitest'
import openapi from '../../openapi.json'
import { actionView, modelCase, promptRoutes, RECORD_CASES, type CaseId } from './model-mocks'
import type { ModelActionView } from '../api/client'
import { ENFORCEMENT } from '../model/enforcement'
import { decideRoute } from './prompt-panel'
import { assertValidQuery } from './schema'

const ajv = new Ajv2020({ strict: false, allErrors: true })
ajv.addSchema(openapi, 'openapi')
const found = ajv.getSchema('openapi#/components/schemas/ModelActionView')
if (!found) throw new Error('ModelActionView is missing from openapi.json')
const validView = found
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

test.skipIf(ENFORCEMENT)('before enforcement nothing arrives approved (P1), as from E2.3', () => {
  for (const id of RECORD_CASES as CaseId[])
    for (const level of LEVELS) expect(actionView(id, {}, level).status).not.toBe('approved')
})

test('the fake decide takes a proposal once, as the server does', async () => {
  const post = (status?: ModelActionView['status']) =>
    Object.values(decideRoute(3, status))[0] as (init: RequestInit) => ModelActionView | Response
  const body = { body: JSON.stringify({ decision: 'proposal_only', applied_by_hand: true }) }
  const once = post()
  expect(once(body)).toMatchObject({ status: 'applied', decision: 'proposal_only' })
  const again = once(body) as Response
  expect(again.status).toBe(409)
  expect(await again.json()).toMatchObject({ code: 'already_decided' })
  expect((post('answered')(body) as Response).status).toBe(409)
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
