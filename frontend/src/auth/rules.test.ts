import { expect, test } from 'vitest'
import { ApiRequestError } from '../api/client'
import { MIN_PASSWORD_LENGTH, passwordError, passwordProblems, safeTarget } from './rules'

test.each([
  ['/admin/daten?reiter=felder', '/admin/daten?reiter=felder'],
  [null, '/'],
  ['https://evil.example', '/'],
  ['//evil.example/x', '/'],
  ['/\\evil.example', '/'],
  ['/\t/evil.example', '/'],
  ['/sitzung/s1#karte', '/sitzung/s1#karte'],
])('sign-in target %s → %s', (target, expected) => {
  expect(safeTarget(target)).toBe(expected)
})

test('password rules of design A4', () => {
  expect(passwordProblems('alt-passwort', 'kurz', '')).toHaveLength(1)
  expect(passwordProblems('alt-passwort', 'alt-passwort', 'alt-passwort')).toEqual([
    'Das neue Passwort muss sich vom alten unterscheiden.',
  ])
  expect(passwordProblems('alt', 'neues-passwort', 'neues-passwor')).toEqual([
    'Die Wiederholung stimmt nicht überein.',
  ])
  expect(passwordProblems('alt', 'neues-passwort', 'neues-passwort')).toEqual([])
})

test('the form asks for 12 characters before the server is asked', () => {
  expect(MIN_PASSWORD_LENGTH).toBe(12)
  expect(passwordProblems('alt', 'elf-zeichen', '')).toEqual([
    'Das neue Passwort braucht mindestens 12 Zeichen.',
  ])
  expect(passwordProblems('alt', 'zwoelf-zeich', '')).toEqual([])
})

test("the server's password rules are told in German, other errors as they come", () => {
  const refused = (code: string) =>
    new ApiRequestError(400, { code, message: 'English text', details: {} })
  expect((passwordError(refused('password_common')) as Error).message).toMatch(/zu verbreitet/)
  expect((passwordError(refused('password_contains_name')) as Error).message).toMatch(
    /Benutzernamen/,
  )
  const other = refused('wrong_password')
  expect(passwordError(other)).toBe(other)
  expect(passwordError(null)).toBeNull()
})
