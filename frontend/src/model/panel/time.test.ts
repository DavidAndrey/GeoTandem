// The panel's times: the server's naive timestamps are UTC (a browser in Bern
// in summer is two hours ahead), and the timer's limit is the backend's.
import { afterAll, beforeAll, expect, test } from 'vitest'
import { parseTimestamp } from '../../i18n/locale'
import { MODEL_LIMITS } from '../../test/model-mocks'
import { MODEL_CALL_S } from './state'
import { clockTime, minutes } from './time'

// The tests run in Node, which reads TZ again whenever it changes.
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } })
  .process.env
let zone: string | undefined
beforeAll(() => {
  // Before any formatter is built: an Intl format keeps the zone it was made in.
  zone = env.TZ
  env.TZ = 'Europe/Zurich'
})
afterAll(() => {
  if (zone === undefined) delete env.TZ
  else env.TZ = zone
})

test('a naive timestamp is UTC, one with a zone is read as written', () => {
  expect(parseTimestamp('2026-10-10T12:05:00').toISOString()).toBe('2026-10-10T12:05:00.000Z')
  expect(parseTimestamp('2026-10-10T12:05:00.123456').toISOString()).toBe(
    '2026-10-10T12:05:00.123Z',
  )
  expect(parseTimestamp('2026-10-10T12:05:00Z').toISOString()).toBe('2026-10-10T12:05:00.000Z')
  expect(parseTimestamp('2026-10-10T14:05:00+02:00').toISOString()).toBe('2026-10-10T12:05:00.000Z')
})

test('the clock time of a prompt is local: 12:05 UTC is 14:05 in Bern in October', () => {
  expect(clockTime('2026-10-10T12:05:00')).toBe('14:05')
  expect(clockTime('2026-10-10T12:05:00Z')).toBe('14:05')
  expect(clockTime(null)).toBe('')
})

test('the timer runs to the backend limit (one value, held to the fixture on both sides)', () => {
  // backend: test_model_flow.py holds MODEL_CALL_S of service.py to the same fixture value.
  expect(MODEL_CALL_S).toBe(MODEL_LIMITS.model_call_s)
  expect(minutes(MODEL_CALL_S)).toBe('2:00')
})
