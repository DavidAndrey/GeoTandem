// Representability, both sides (plan D3, WP80): ``toAnalysis`` (analysis/query.ts)
// agrees with the backend's ``to_analysis`` (represent.py) on every case of
// schema/model-cases/represent.json, over the case file's catalog. A query the
// server lets through finds the case's analysis, becomes an editor draft, and
// the draft, applied, writes back the same query object; a query it refuses is
// refused here too, naming the same part. So "In Editor übernehmen" works for
// every proposal the server makes, and "as proposed" can be told by comparing
// queries.
import { expect, test } from 'vitest'
import cases from '../../../schema/model-cases/represent.json'
import type { Analysis } from '../analysis/model'
import { canonicalQuery, resultQuery, toAnalysis } from '../analysis/query'
import type { FieldType } from '../editor/describe'
import { attribute, layer } from '../test/fixtures'
import { proposalDraft } from './panel/draft'
import { readQuery } from './readable'

/** The case file's catalog (kind and field types per layer) as the layer list. */
const CATALOG = Object.entries(
  cases.catalog as Record<string, { kind: 'vector' | 'table'; attributes: Record<string, string> }>,
).map(([name, shape]) =>
  layer({
    name,
    title: name,
    kind: shape.kind,
    attributes: Object.entries(shape.attributes).map(([attr, type]) =>
      attribute({ name: attr, label: attr, data_type: type as FieldType }),
    ),
  }),
)

/** A tree without its node ids: the case file leaves them out. */
function withoutIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutIds)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'id')
      .map(([key, inner]) => [key, withoutIds(inner)]),
  )
}

function applied(result: string, tree: Analysis['tree']): Analysis {
  return {
    layers: [
      {
        id: result,
        source: { kind: 'catalog', layer: result },
        visible: true,
        opacity: 1,
        symbology: null,
      },
    ],
    result,
    tree,
    restriction: null,
  }
}

test.each(cases.representable.map((c) => [c.id, c] as const))(
  'representable "%s": the case\'s analysis, and a draft that writes the same query back',
  (_, c) => {
    const found = toAnalysis(c.query, CATALOG)
    expect(found.part).toBeNull()
    const { symbology, ...analysis } = c.analysis
    expect(symbology).toBeNull()
    expect(withoutIds(found.analysis)).toEqual(analysis)
    const draft = proposalDraft(c.query, 7, CATALOG)
    expect(draft).not.toBeNull()
    if (!draft) return
    expect(draft.result).toBe(c.query.source)
    const query = resultQuery(applied(draft.result, draft.tree))
    expect(canonicalQuery(query)).toBe(canonicalQuery(c.query))
    // analysis → query → analysis
    expect(toAnalysis(query, CATALOG)).toEqual(found)
  },
)

test.each(cases.not_representable.map((c) => [c.id, c] as const))(
  'refused on both sides "%s": the same part, no draft',
  (_, c) => {
    expect(toAnalysis(c.query, CATALOG)).toEqual({ analysis: null, part: c.part })
    expect(proposalDraft(c.query, 7, CATALOG)).toBeNull()
  },
)

test('without the layer list nothing is representable: the source is unknown', () => {
  const [one] = cases.representable.filter((c) => c.id === 'one_compare')
  expect(toAnalysis(one?.query, undefined)).toEqual({ analysis: null, part: 'source' })
  expect(proposalDraft(one?.query, 7, undefined)).toBeNull()
})

test("a draft's row ids are the action's, so origin marks never fall on another answer", () => {
  const [reference] = cases.representable.filter((c) => c.id === 'reference')
  const draft = proposalDraft(reference?.query, 7, CATALOG)
  expect(draft?.tree.id).toBe('root')
  expect(draft?.tree.children.map((child) => child.id)).toEqual(['m7:q0.0', 'm7:q0.1', 'm7:q0.2'])
})

test('a date range on ge and le is one row, as the editor writes it', () => {
  const [range] = cases.representable.filter((c) => c.id === 'date_range')
  const tree = readQuery(range?.query).tree
  expect(tree.children).toHaveLength(1)
  expect(tree.children[0]).toMatchObject({
    kind: 'attribute',
    attr: 'eroeffnet',
    operator: 'between',
    min: '2020-01-01',
  })
})
