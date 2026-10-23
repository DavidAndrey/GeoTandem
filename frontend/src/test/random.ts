// Random analyses for property tests: every kind of row, complete or not
// (``randomNode``), or only those in the canonical form ``toAnalysis`` gives
// back (``canonicalPart``, the round trip of D3).
import type {
  AttributeOperator,
  AttributeRow,
  Group,
  Node,
  QueryPart,
  Row,
  Scalar,
  SpatialOperator,
} from '../analysis/model'
import type { LayerInfo } from '../api/client'
import { operatorsFor, type FieldType } from '../editor/describe'
import { attribute, layer } from './fixtures'

export function random(seed: number) {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const OPERATORS: AttributeOperator[] = [
  'eq',
  'ne',
  'lt',
  'le',
  'gt',
  'ge',
  'between',
  'contains',
  'starts_with',
  'ends_with',
  'is_empty',
  'in',
]
const SPATIAL: SpatialOperator[] = ['in', 'outside', 'intersects', 'contains', 'near', 'far']

export function randomNode(next: () => number, depth: number, id: { n: number }): Node {
  const pick = <T>(items: T[]): T => items[Math.floor(next() * items.length)] as T
  const maybe = <T>(value: T): T | null => (next() < 0.25 ? null : value)
  const kind =
    depth > 2
      ? pick(['attribute', 'spatial', 'reference'])
      : pick(['group', 'attribute', 'spatial', 'reference'])
  const key = `n${id.n++}`
  if (kind === 'group')
    return {
      id: key,
      kind: 'group',
      op: pick(['and', 'or'] as const),
      not: next() < 0.3,
      children: Array.from({ length: Math.floor(next() * 4) }, () =>
        randomNode(next, depth + 1, id),
      ),
    }
  if (kind === 'reference')
    return {
      id: key,
      kind: 'reference',
      not: next() < 0.3,
      layer: pick(['strassen', '']),
      fid: maybe(Math.floor(next() * 10)),
      label: '',
      distance_m: Math.floor(next() * 1000),
    }
  const filter = (): AttributeRow => ({
    id: `${key}f`,
    kind: 'attribute',
    not: next() < 0.3,
    attr: pick(['typ', 'schueler', '']),
    operator: pick(OPERATORS),
    value: maybe(pick<string | number | boolean>(['primar', 12, 3.5, true, ''])),
    min: maybe(Math.floor(next() * 100)),
    max: maybe(Math.floor(next() * 100)),
    values: next() < 0.3 ? [] : [pick<string | number>(['a', 2])],
  })
  if (kind === 'attribute') return filter()
  return {
    id: key,
    kind: 'spatial',
    not: next() < 0.3,
    operator: pick(SPATIAL),
    layer: pick(['strassen', 'gemeinden', '']),
    distance_m: maybe(Math.floor(next() * 2000) - 100),
    filter: next() < 0.5 ? null : filter(),
  }
}

// --- canonical analyses (D3 round trip) ------------------------------------------

const vector = (
  name: string,
  fields: Record<string, FieldType>,
  kind: LayerInfo['kind'] = 'vector',
) =>
  layer({
    name,
    title: name,
    kind,
    attributes: Object.entries(fields).map(([field, type]) =>
      attribute({ name: field, label: field, data_type: type }),
    ),
  })

/** The fixed catalog of ``canonicalPart``: every field type, and a table layer never named. */
export const ROUND_TRIP_LAYERS: LayerInfo[] = [
  vector('schulen', {
    name: 'text',
    typ: 'text',
    standorte: 'integer',
    flaeche: 'real',
    kindergarten: 'boolean',
    eroeffnet: 'date',
  }),
  vector('strassen', { klasse: 'text', breite: 'real' }),
  vector('gemeinden', { gem_nr: 'integer', name: 'text', gegruendet: 'date' }),
  vector('gemeindedaten', { gem_nr: 'integer', einwohner: 'integer' }, 'table'),
]

const RESULT = 'schulen'
const OTHERS = ['strassen', 'gemeinden']

/**
 * A random analysis in the canonical form of ``toAnalysis`` over
 * ``ROUND_TRIP_LAYERS``: complete rows only, no empty value; groups of two or
 * more children; the root a non-negated ``and`` that is not one ``and`` alone;
 * NICHT only on groups, attribute rows and "schneidet" / "enthält" relations
 * ("liegt in" and "≤ Distanz" negated are "ausserhalb" and "> Distanz");
 * a relation's filter one attribute row without NICHT; a date range as
 * "zwischen" with ISO dates in order (so no ``ge`` compare on a date, which
 * next to a ``le`` would read as one); numbers in order on a number range;
 * relations and references to a vector layer other than the result; no
 * restriction. Node ids are fresh and mean nothing.
 */
export function canonicalPart(next: () => number): QueryPart {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T
  const int = (n: number) => Math.floor(next() * n)
  let n = 0
  const id = () => `c${n++}`
  const date = () =>
    `20${String(10 + int(20))}-${String(1 + int(12)).padStart(2, '0')}-${String(1 + int(28)).padStart(2, '0')}`
  const valueOf = (type: FieldType): Scalar => {
    switch (type) {
      case 'text':
        return pick(['primar', 'Bern', 'kantonsstrasse_b', 'x'])
      case 'integer':
        return int(1000) - 100
      case 'real':
        return pick([0.5, 1.6, 12.25, 300])
      case 'boolean':
        return next() < 0.5
      case 'date':
        return date()
    }
  }

  const attributeRow = (on: string, negatable: boolean): AttributeRow => {
    const fields = ROUND_TRIP_LAYERS.find((l) => l.name === on)?.attributes ?? []
    const field = pick(fields)
    const type = field.data_type
    const operators = operatorsFor(type).filter((op) => type !== 'date' || op !== 'ge')
    const operator: AttributeOperator = pick(operators)
    const row: AttributeRow = {
      id: id(),
      kind: 'attribute',
      not: negatable && next() < 0.3,
      attr: field.name,
      operator,
      value: null,
      min: null,
      max: null,
      values: [],
    }
    switch (operator) {
      case 'between': {
        const [a, b] = [valueOf(type), valueOf(type)] as [number | string, number | string]
        return { ...row, min: a <= b ? a : b, max: a <= b ? b : a }
      }
      case 'in':
        return { ...row, values: Array.from({ length: 1 + int(3) }, () => valueOf(type)) }
      case 'is_empty':
        return row
      default:
        return { ...row, value: valueOf(type) }
    }
  }

  const row = (): Row => {
    const kind = pick(['attribute', 'attribute', 'spatial', 'reference'] as const)
    if (kind === 'attribute') return attributeRow(RESULT, true)
    const other = pick(OTHERS)
    if (kind === 'reference')
      return {
        id: id(),
        kind: 'reference',
        not: false,
        layer: other,
        fid: int(50),
        label: '',
        distance_m: int(3) === 0 ? 0 : 1 + int(2000),
      }
    const operator: SpatialOperator = pick([
      'in',
      'outside',
      'intersects',
      'contains',
      'near',
      'far',
    ])
    const distance = operator === 'near' || operator === 'far' ? 1 + int(2000) : null
    return {
      id: id(),
      kind: 'spatial',
      not: (operator === 'intersects' || operator === 'contains') && next() < 0.3,
      operator,
      layer: other,
      distance_m: distance,
      filter: next() < 0.5 ? null : attributeRow(other, false),
    }
  }

  const node = (depth: number): Node => {
    if (depth > 2 || next() < 0.65) return row()
    const group: Group = {
      id: id(),
      kind: 'group',
      op: next() < 0.5 ? 'and' : 'or',
      not: next() < 0.3,
      children: Array.from({ length: 2 + int(3) }, () => node(depth + 1)),
    }
    return group
  }

  let children = Array.from({ length: int(5) }, () => node(1))
  // One ``and`` alone is written as the root's own children: it gives them.
  const [only] = children
  if (children.length === 1 && only?.kind === 'group' && only.op === 'and' && !only.not)
    children = only.children
  return {
    result: RESULT,
    tree: { id: 'root', kind: 'group', op: 'and', not: false, children },
    restriction: null,
  }
}
