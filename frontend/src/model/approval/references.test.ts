import { describe, expect, test } from 'vitest'
import type { QueryObject } from '../../analysis/model'
import { attribute, layer } from '../../test/fixtures'
import { actionView } from '../../test/model-mocks'
import { referencesOf } from './references'

const catalog = [
  layer({
    name: 'schulen',
    title: 'Schulen',
    geometry_type: 'Point',
    attributes: [attribute({ name: 'typ', data_type: 'text', label: 'Schulstufe' })],
  }),
  layer({
    name: 'gemeinden',
    title: 'Gemeinden',
    feature_count: 30,
    attributes: [attribute({ name: 'name', data_type: 'text', label: 'Gemeindename' })],
  }),
  layer({ name: 'strassen', title: 'Strassen', geometry_type: 'LineString', attributes: [] }),
]

const koeniz = { op: 'compare', attr: 'name', cmp: 'eq', value: 'Köniz' }

/** A waiting proposal on Schulen with ``where``. */
const proposing = (where: unknown) =>
  actionView('reference', {
    query: { schema_version: '2', source: 'schulen', where, output: 'map' } as QueryObject,
  })

describe('referencesOf (review #4d)', () => {
  test('a filtered relation is drawn: its layer with its filter, named as the editor names it', () => {
    const refs = referencesOf(
      proposing({ op: 'related', layer: 'gemeinden', predicate: 'within', where: koeniz }),
      catalog,
      10000,
    )
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({
      layer: 'gemeinden',
      text: 'liegt in Gemeinden (Gemeindename = Köniz)',
      query: { source: 'gemeinden', where: koeniz, output: 'map' },
      limited: false,
    })
  })

  test('a relation to a whole layer is only named, not drawn', () => {
    const refs = referencesOf(
      proposing({ op: 'related', layer: 'strassen', predicate: 'dwithin', distance_m: 200 }),
      catalog,
      10000,
    )
    expect(refs).toEqual([expect.objectContaining({ text: 'Strassen (alle)', query: null })])
  })

  test('a chosen object is drawn by its id', () => {
    const refs = referencesOf(
      proposing({ op: 'near_feature', layer: 'gemeinden', fid: 7, distance_m: 0 }),
      catalog,
      10000,
    )
    expect(refs[0]?.query?.where).toEqual({ op: 'compare', attr: 'fid', cmp: 'eq', value: 7 })
  })

  test('a negated relation refers to the same objects; two naming them are drawn once', () => {
    const inside = { op: 'related', layer: 'gemeinden', predicate: 'within', where: koeniz }
    const refs = referencesOf(
      proposing({ op: 'or', args: [inside, { op: 'not', arg: inside }] }),
      catalog,
      10000,
    )
    expect(refs).toHaveLength(1)
    expect(refs[0]?.query?.where).toEqual(koeniz)
  })

  test('attribute conditions refer to nothing; a layer beyond the map limit is drawn in the view only', () => {
    const where = {
      op: 'and',
      args: [
        { op: 'compare', attr: 'typ', cmp: 'eq', value: 'primar' },
        { op: 'related', layer: 'gemeinden', predicate: 'within', where: koeniz },
      ],
    }
    expect(referencesOf(proposing(where), catalog, 10)).toEqual([
      expect.objectContaining({ layer: 'gemeinden', limited: true }),
    ])
  })
})
