import { expect, test } from 'vitest'
import codes from '../../error-codes.json'
import { ApiRequestError } from '../api/client'
import { errorText, KNOWN_CODES, messageText } from './errors'

test('every code the back end can send has words (plan E1.9, L6)', () => {
  expect(Object.keys(codes).filter((code) => !KNOWN_CODES.includes(code))).toEqual([])
  expect(KNOWN_CODES.filter((code) => !(code in codes))).toEqual([])
})

test('a refusal reads in German, from its code and details', () => {
  const refused = (code: string, details = {}) =>
    new ApiRequestError(400, { code, message: 'English text', details })
  expect(refused('password_common').message).toMatch(/zu verbreitet/)
  expect(refused('name_clash', { attribute: 'summe' }).message).toBe(
    'Der Name „summe" ist schon vergeben; bitte einen anderen Namen oder ein Präfix wählen.',
  )
  // A refused file names its reason.
  expect(refused('unreadable_source', { reason: 'archive_encrypted' }).message).toBe(
    'Das Archiv ist verschlüsselt und kann nicht gelesen werden.',
  )
  // A code from a newer back end: its English rather than nothing.
  expect(refused('brand_new').message).toBe('English text')
  expect(new ApiRequestError(502, undefined).message).toBe('HTTP 502')
})

test('import findings carry their numbers and names', () => {
  expect(messageText({ code: 'rejected_rows', message: '1200 records…', count: 1200 })).toBe(
    "1'200 Datensätze wurden nicht importiert.",
  )
  expect(messageText({ code: 'repaired', message: '…', count: 1 })).toBe(
    '1 Geometrie wurde repariert.',
  )
  expect(messageText({ code: 'stored_as_text', message: '…', column: 'plz', details: {} })).toBe(
    'Die Spalte „plz" wird als Text gespeichert.',
  )
  expect(errorText('duplicate_header', { columns: ['Name', 'Name'] })).toBe(
    'Gleich benannte Spalten werden mit einer Nummer unterschieden: „Name", „Name".',
  )
})
