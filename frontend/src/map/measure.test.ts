import { expect, test } from 'vitest'
import {
  areaOf,
  formatArea,
  formatLength,
  lengthOf,
  reduceDrawing,
  type Drawing,
  type DrawingAction,
} from './measure'

// Reference values from PROJ's geodesic (pyproj.Geod, WGS84), an independent implementation.

test('distances are geodesic on the ellipsoid', () => {
  expect(
    lengthOf([
      [46.9466, 7.444],
      [46.948, 7.4475],
    ]),
  ).toBeCloseTo(308.58187, 4)
  // One degree of latitude at 47° N: 111.171 km on WGS84, 111.195 km on a sphere.
  expect(
    lengthOf([
      [46.5, 7.5],
      [47.5, 7.5],
    ]),
  ).toBeCloseTo(111_170.83976, 3)
  // A line through three points adds its segments.
  const a: [number, number] = [46.9, 7.4]
  const b: [number, number] = [46.95, 7.4]
  const c: [number, number] = [46.95, 7.45]
  expect(lengthOf([a, b, c])).toBeCloseTo(lengthOf([a, b]) + lengthOf([b, c]), 6)
  expect(lengthOf([a])).toBe(0)
})

test('areas are geodesic too, whatever the drawing direction', () => {
  // A square of 0.01° at 47° N.
  const square: [number, number][] = [
    [47, 7.4],
    [47.01, 7.4],
    [47.01, 7.41],
    [47, 7.41],
  ]
  const { area, perimeter } = areaOf(square)
  expect(area).toBeCloseTo(845_442.79117, 2)
  expect(perimeter).toBeCloseTo(3_744.39683, 4)
  expect(areaOf([...square].reverse()).area).toBeCloseTo(area, 3)
  expect(areaOf(square.slice(0, 2)).area).toBe(0)
})

test('values read in the Swiss format with a fitting unit', () => {
  expect(formatLength(4.26)).toBe('4.3 m')
  expect(formatLength(850.4)).toBe('850 m')
  expect(formatLength(12_345)).toBe('12.35 km')
  expect(formatLength(250_000)).toBe('250.0 km')
  expect(formatArea(850)).toBe('850 m²')
  expect(formatArea(32_000)).toBe('3.20 ha')
  expect(formatArea(12_400_000)).toBe('12.40 km²')
  // The thousands separator is the environment's de-CH one (' or ’).
  expect(formatArea(1_250_000_000)).toBe(
    `${(1250).toLocaleString('de-CH', { minimumFractionDigits: 1 })} km²`,
  )
})

test('a double click to finish adds its point once', () => {
  const start: Drawing = { points: [], cursor: null, done: false, exit: false }
  const a: [number, number] = [46.9, 7.4]
  const b: [number, number] = [46.95, 7.45]
  // The browser sends click, click, dblclick at B.
  const clicks: DrawingAction[] = [
    { type: 'add', point: a },
    { type: 'add', point: b },
    { type: 'add', point: b },
    { type: 'finish' },
  ]
  const end = clicks.reduce(reduceDrawing, start)
  expect(end).toMatchObject({ points: [a, b], done: true })
  // After finishing, a click at the same spot starts a new drawing there.
  expect(reduceDrawing(end, { type: 'add', point: b }).points).toEqual([b])
})
