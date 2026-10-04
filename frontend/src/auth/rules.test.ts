import { expect, test } from 'vitest'
import { passwordProblems, safeTarget } from './rules'

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
