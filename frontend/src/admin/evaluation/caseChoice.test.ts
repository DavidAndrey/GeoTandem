// A run's choice of cases and its handover from the case list (design V4 step 2).
import { expect, test } from 'vitest'
import { casePage } from '../../test/eval-mocks'
import {
  choiceForList,
  choiceFromParams,
  choiceParams,
  chosenCases,
  type CaseChoice,
} from './caseChoice'

const all = casePage().items
const own = all.filter((v) => !v.read_only)

test('a choice survives the address', () => {
  const choice: CaseChoice = {
    start: false,
    own: true,
    ownState: 'live',
    split: 'confirm',
    tag: 'near',
  }
  expect(choiceParams(choice).toString()).toBe(
    'faelle=eigene&datenstand=live&teil=confirm&stichwort=near',
  )
  expect(choiceFromParams(choiceParams(choice))).toEqual(choice)
  const both: CaseChoice = { start: true, own: true, ownState: 'live', split: null, tag: null }
  expect(choiceFromParams(choiceParams(both))).toMatchObject({ start: true, own: true })
  expect(choiceFromParams(new URLSearchParams('umfang=schnell'))).toBeNull()
})

test('the stale and invalid cases never run', () => {
  const taken = chosenCases(all, {
    start: false,
    own: true,
    ownState: 'live',
    split: null,
    tag: null,
  })
  expect(taken.map((v) => v.case.id)).toEqual(['e-turnhalle-ostermundigen', 'e-schulweg-import'])
})

test('a list filter is handed over only when a run takes exactly the listed cases', () => {
  // Own on live data: exact (the stale one is listed but runs nowhere).
  expect(choiceForList(all, own, { dataState: 'live' })).toMatchObject({ start: false, own: true })
  // The start set: exact.
  const start = all.filter((v) => v.read_only)
  expect(choiceForList(all, start, { origin: 'start' })).toMatchObject({ start: true, own: false })
  // Imported only: a run takes every own case.
  const imported = own.filter((v) => v.case.origin === 'import')
  expect(choiceForList(all, imported, { origin: 'import' })).toBeNull()
  // Start and own live cases together: two data states, no single run.
  expect(choiceForList(all, all, {})).toBeNull()
  // Nothing that runs.
  expect(choiceForList(all, [], { tag: 'nothing' })).toBeNull()
})
