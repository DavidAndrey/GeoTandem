// A run in words (plan WP93): numbers, verdict mixes, groups, the stage-1 diff.
import { expect, test } from 'vitest'
import type { RunSummary } from '../../api/client'
import { answerViews, runPage, runView } from '../../test/eval-mocks'
import { LAYERS } from '../../test/run-api'
import { measuredText } from './measured'
import { labelsFor } from '../../editor/fields'
import { catalogLayer } from '../../model/approval/changes'
import {
  comparable,
  diffChange,
  differenceText,
  groupCases,
  idsText,
  mixText,
  pointName,
  progressPercent,
  repeatNames,
  sumCells,
  tokensText,
} from './runWords'

const words = labelsFor(catalogLayer('schulen'), LAYERS)

test('numbers: the difference with its interval, tokens, progress', () => {
  expect(differenceText({ mean: 6.6, low: 1.3, high: 13.2 })).toBe('+6.6 Punkte (+1.3 … +13.2)')
  expect(differenceText({ mean: 0, low: -2, high: 2 })).toBe('0.0 Punkte (-2.0 … +2.0)')
  expect(tokensText(8_500_000)).toBe('8.5 Mio')
  expect(progressPercent(1164, 2840)).toBe(41)
  expect(progressPercent(2839, 2840)).toBe(99)
  expect(progressPercent(2840, 2840)).toBe(100)
})

test("a cell's verdict mix in short form, passes left out", () => {
  expect(mixText({ verdicts: { pass: 1, wrong: 9, refused: 1 } })).toBe('9 f · 1 a')
  expect(mixText({ verdicts: { pass: 10 } })).toBe('')
  expect(mixText({ verdicts: { kind: 2, error: 1 } })).toBe('2 x · 1 n')
})

test('two runs are comparable only when both are done and asked the same cases', () => {
  const [running, done, quick, interrupted] = runPage().items as RunSummary[]
  expect(comparable(done, quick)).toBeNull()
  // *fertig* is the status, *vollständig* only the scope 2 × 5.
  expect(comparable(done, interrupted)).toMatch(/#10 ist nicht fertig; .* bei fertigen Läufen/)
  expect(comparable(running, done)).toMatch(/#14 ist nicht fertig/)
  expect(comparable(done, { ...quick, case_set_hash: 'other' })).toMatch(/andere Prüffälle/)
})

test('groups by first tag, behaviour cases together; sums per point', () => {
  const run = runView('done')
  const groups = groupCases(run.cases, 'tuning')
  expect(groups.map((g) => g.title)).toEqual([
    'räumlich',
    'Kombination',
    'Attribut',
    'Verhalten',
    'Zählung',
    'mehrdeutig',
  ])
  expect(groups.reduce((n, g) => n + g.cases.length, 0)).toBe(33)
  const behaviour = groups.find((g) => g.key === ':behaviour')
  expect(behaviour?.cases.map((rc) => rc.case.id)).toContain('n15-je-gemeinde')
  const ids = new Set(['doc1-primar-koeniz', 'n13-bahnhof-bern'])
  expect(sumCells(run.cells, ids, 3)).toEqual({ passed: 13, answers: 20 })
})

test('repeats are named by block and position', () => {
  const names = [...repeatNames(answerViews()).values()]
  expect(names).toEqual(['1.1', '1.2', '1.3', '1.4', '1.5', '2.1', '2.2', '2.3', '2.4', '2.5'])
})

test('the stage-1 diff in words: + − ~, other parts by name with their JSON', () => {
  const missing = answerViews()[1].diff?.[0]
  if (!missing) throw new Error('no diff')
  expect(diffChange(missing, words)).toEqual({
    sign: '−',
    text: expect.stringMatching(/^fehlende Bedingung: .*Haltestellen/),
  })
  expect(
    diffChange(
      { kind: 'source', path: 'source', reference: 'schulen', answer: 'gemeinden' },
      words,
    ),
  ).toEqual({ sign: '~', text: 'Ergebnis-Layer: Schulen → Gemeinden' })
  expect(
    diffChange(
      {
        kind: 'added',
        path: 'where.args[2]',
        reference: null,
        answer: { op: 'compare', attr: 'typ', cmp: 'eq', value: 'primar' },
      },
      words,
    ).text,
  ).toMatch(/^zusätzliche Bedingung: Schulstufe/)
  // Parts besides where, by their name.
  expect(diffChange({ kind: 'changed', path: 'limit', reference: 10, answer: 20 }, words)).toEqual({
    sign: '~',
    text: 'Begrenzung geändert: 10 → 20',
  })
  expect(
    diffChange({ kind: 'missing', path: 'limit', reference: 10, answer: null }, words),
  ).toEqual({ sign: '−', text: 'Begrenzung fehlt: 10' })
  expect(
    diffChange({ kind: 'added', path: 'buffer', reference: null, answer: { m: 50 } }, words),
  ).toEqual({ sign: '+', text: 'Puffer zusätzlich: {"m":50}' })
  expect(
    diffChange(
      { kind: 'changed', path: 'order_by', reference: [{ attr: 'a' }], answer: [{ attr: 'b' }] },
      words,
    ).text,
  ).toBe('Sortierung geändert: [{"attr":"a"}] → [{"attr":"b"}]')
  for (const path of ['aggregate', 'columns', 'attribute_join', 'spatial_relation'])
    expect(
      diffChange({ kind: 'missing', path, reference: {}, answer: null }, words).text,
    ).not.toMatch(new RegExp(`^${path}`))
})

test('ids: twelve named, the rest counted against the exact total', () => {
  expect(idsText([1, 2], 2)).toBe('Objekt 1, Objekt 2')
  const ids = Array.from({ length: 200 }, (_, i) => i + 1)
  expect(idsText(ids, 213)).toMatch(/Objekt 12 und 201 weitere$/)
})

test('V8.1 "Gemessen": the reference column on the cases that use a layer', () => {
  const run = runView('done')
  expect(measuredText(run, 'haltestellen')).toMatch(
    /^Gemessen: gpt-6-luna P0 hatte auf diesem Layer \d+ von \d+ Antworten richtig \(Lauf #13, \d+ Fälle?\)\.$/,
  )
  expect(measuredText(run, 'kitas')).toBeNull()
  // Another profile shown than the run had: said, with the run's hash.
  expect(measuredText(run, 'haltestellen', run.label.profile.profile_hash)).not.toMatch(/damals/)
  expect(measuredText(run, 'haltestellen', 'ff'.repeat(32))).toMatch(
    / Steckbrief damals #b20a, heute anders\.$/,
  )
})

test('a column by connection and the parts of its profile that differ from the default', () => {
  const [gemma, haiku, , lunaP9] = runView('done').points.map((p) => p.label)
  expect(pointName(gemma)).toBe('gemma4:12b P0')
  expect(pointName(haiku)).toBe('Claude Haiku 5.5 P0 · nur Text')
  expect(pointName(lunaP9)).toBe('gpt-6-luna P9')
})
