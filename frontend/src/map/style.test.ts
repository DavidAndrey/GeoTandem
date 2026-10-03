import { expect, test } from 'vitest'
import { ACCENT, featureStyle, markStyle } from './style'

test('a selection is outline and dashed ring, never a colour of its own (design B9)', () => {
  const hit = featureStyle(ACCENT, 1, 'hit')
  const ring = markStyle('selected', 'ring', hit.radius)
  const outline = markStyle('selected', 'outline', hit.radius)
  for (const part of [ring, outline]) {
    expect(part.fill).toBe(false)
    expect(part.color).not.toBe(ACCENT)
  }
  expect(outline.radius).toBe(hit.radius)
  expect(ring.radius).toBe(hit.radius + 6)
  expect(ring).toHaveProperty('dashArray')
  // Hovering is lighter and never dashed like a selection.
  expect(markStyle('hover', 'ring').opacity).toBeLessThan(1)
  expect(markStyle('hover', 'ring')).not.toHaveProperty('dashArray')
})

test('the ring follows the drawn size of graduated symbols', () => {
  expect(markStyle('selected', 'ring', 20).radius).toBe(26)
})
