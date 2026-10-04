import { expect, test } from 'vitest'
import { keys } from './queries'

test('a layer named "list" has a cache entry of its own, not the catalog', () => {
  expect(keys.layer('list')).not.toEqual(keys.layerList)
  expect(keys.layer('list').slice(0, 2)).not.toEqual(keys.layerList)
})
