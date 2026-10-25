// The fake API's evaluation views keep the contract (plan WP85): every view
// built here is valid against the backend's own OpenAPI schema.
import Ajv2020 from 'ajv/dist/2020'
import { expect, test } from 'vitest'
import openapi from '../../openapi.json'
import {
  answerViews,
  behaviourAnswer,
  CONNECTIONS,
  LEVELS,
  refusedAnswers,
  rightOtherwise,
  casePage,
  caseView,
  COST_ESTIMATE,
  OWN_CASES,
  PROFILE_COMPLETE,
  PROFILE_RAW,
  RUN_COMPARISON,
  runPage,
  runView,
  START_CASES,
} from './eval-mocks'
import { readings } from '../admin/evaluation/words'
import { assertValidQuery } from './schema'

const ajv = new Ajv2020({ strict: false, allErrors: true })
ajv.addSchema(openapi, 'openapi')

function valid(name: string, value: unknown) {
  const validate = ajv.getSchema(`openapi#/components/schemas/${name}`)
  if (!validate) throw new Error(`${name} is missing from openapi.json`)
  expect(validate(value), JSON.stringify(validate.errors?.slice(0, 3))).toBe(true)
}

test('the start set is the 71 cases of schema/eval-cases', () => {
  expect(START_CASES).toHaveLength(71)
  expect(new Set(START_CASES.map((c) => c.id)).size).toBe(71)
})

test('every case view is valid, start cases read-only and own cases editable', () => {
  valid('CasePage', casePage())
  for (const item of casePage().items) valid('CaseView', item)
  expect(caseView('doc1-primar-koeniz').read_only).toBe(true)
  expect(caseView('e-kitas-bahnhof')).toMatchObject({
    read_only: false,
    status: 'stale',
    status_layers: ['kitas'],
  })
  expect(caseView('e-turnhalle-ostermundigen').status_layers).toEqual([])
})

test('a case view sends null for an unset optional field, as the backend does', () => {
  const view = caseView('doc1-primar-koeniz')
  for (const key of ['origin_action', 'gold', 'require', 'expect', 'other_approach'] as const)
    expect(view.case[key]).toBeNull()
  expect(caseView('n15-je-gemeinde').case.gold_any).toBeNull()
  valid('CaseView', caseView('e-kitas-bahnhof', { status: 'invalid', status_layers: [] }))
})

test('a run keeps each case whole as it asked it (H7)', () => {
  const view = runView('done')
  expect(view.cases).toHaveLength(71)
  expect(view.cases[0].case).toEqual(START_CASES[0])
  expect(view.cases.every((c) => c.status === 'ok')).toBe(true)
})

test('every reference of a case is a valid query object', () => {
  for (const c of [...START_CASES, ...OWN_CASES.map((o) => o.case)]) {
    for (const gold of readings(c)) {
      assertValidQuery({ schema_version: c.schema_version ?? '2', output: 'map', ...gold })
    }
  }
})

test('runs are valid while running, done and as a quick test', () => {
  for (const view of [runView('running'), runView('done'), runView('done', 'quick')]) {
    valid('RunView', view)
  }
  valid('RunPage', runPage())
})

test('figures wait for the end, comparisons for a full run (design review 5, D7)', () => {
  expect(runView('running').points.every((p) => p.figures === null)).toBe(true)
  expect(runView('done', 'quick').points.every((p) => p.comparison === null)).toBe(true)
  const done = runView('done')
  expect(done.points[done.reference].comparison).toBeNull()
  expect(done.points.map((p) => p.comparison?.word ?? null)).toEqual([
    'not_proven',
    'better',
    null,
    'better',
  ])
})

test('estimate, answers, comparison and profile summaries are valid', () => {
  valid('CostEstimate', COST_ESTIMATE)
  for (const answer of [...answerViews(), rightOtherwise(), ...refusedAnswers(), behaviourAnswer()])
    valid('AnswerView', answer)
  for (const connection of CONNECTIONS) valid('ConnectionInfo', connection)
  valid('LevelSet', LEVELS)
  valid('RunComparison', RUN_COMPARISON)
  valid('ProfileSummary', PROFILE_COMPLETE)
  valid('ProfileSummary', PROFILE_RAW)
})

test('the silently wrong answers of n13 have no assumption', () => {
  const wrong = answerViews().filter((a) => a.verdict === 'wrong')
  expect(wrong).toHaveLength(6)
  expect(wrong.every((a) => a.flags?.includes('no_assumption'))).toBe(true)
})
