// Random analyses for property tests: every kind of row, complete or not.
import type { AttributeOperator, AttributeRow, Node, SpatialOperator } from '../analysis/model'

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
