// Representability, both sides (plan D3): every query the server lets through
// as representable (schema/model-cases/represent.json, backend represent.py)
// becomes an editor draft here, and the draft, applied, writes back the same
// query object. So "In Editor übernehmen" works for every proposal the server
// makes, and "as proposed" can be told by comparing queries.
import { expect, test } from 'vitest'
import cases from '../../../schema/model-cases/represent.json'
import type { Analysis } from '../analysis/model'
import { resultQuery } from '../analysis/query'
import { proposalDraft } from './panel/draft'
import { readQuery } from './readable'

/** The schema's defaults a case may leave out and the server's view carries
 * (``compact`` keeps every set value, defaults included). */
const DEFAULTS: Record<string, Record<string, unknown>> = {
  text_match: { mode: 'contains', case_sensitive: false },
  near_feature: { distance_m: 0 },
}

/** JSON with sorted keys, as the server sends the query: defaults filled in. */
function canonical(query: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort)
    if (v === null || typeof v !== 'object') return v
    const op = (v as { op?: unknown }).op
    const filled = { ...(typeof op === 'string' ? DEFAULTS[op] : {}), ...v }
    return Object.fromEntries(
      Object.keys(filled)
        .sort()
        .map((k) => [k, sort((filled as Record<string, unknown>)[k])]),
    )
  }
  return JSON.stringify(sort({ schema_version: '2', output: 'map', ...(query as object) }))
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
  'representable "%s": a draft that writes the same query back',
  (_, c) => {
    const draft = proposalDraft(c.query, 7)
    expect(draft).not.toBeNull()
    if (!draft) return
    expect(draft.result).toBe(c.query.source)
    expect(canonical(resultQuery(applied(draft.result, draft.tree)))).toBe(canonical(c.query))
  },
)

// The other direction needs the field types the server checks (the frontend
// reads no catalog here): its cases are refused before they reach a draft.
test.each(
  ['double_negation', 'negated_outside', 'view_restriction_only', 'one_row_and_view_restriction']
    .map((id) => cases.not_representable.find((c) => c.id === id))
    .map((c) => [c?.id, c] as const),
)('refused on both sides "%s": no draft', (_, c) => {
  expect(c).toBeDefined()
  expect(proposalDraft(c?.query, 7)).toBeNull()
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
