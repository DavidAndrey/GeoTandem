import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, test, vi } from 'vitest'
import { App } from '../App'
import type { CellMode, Level } from '../api/client'
import { signedIn } from '../test/fixtures'
import { fakeApi, renderAt } from '../test/render'

afterEach(() => vi.unstubAllGlobals())

const all = (mode: CellMode) =>
  Object.fromEntries(['catalog', 'query', 'spatial', 'derive', 'display'].map((c) => [c, mode]))

const level = (patch: Partial<Level>): Level => ({
  id: 1,
  name: 'Assistenz',
  description: '',
  system_prompt: 'Du bist …',
  selectable: true,
  is_default: false,
  matrix: all('off'),
  ...patch,
})

const shipped = [
  level({ id: 1, name: 'Assistenz' }),
  level({ id: 2, name: 'Prüfen', is_default: true, matrix: all('approve') }),
  level({ id: 3, name: 'Automatisch', selectable: false, matrix: all('auto') }),
]

const saved = (calls: { key: string; body: unknown }[]) =>
  calls.filter((c) => c.key === 'PUT /api/admin/levels').map((c) => c.body)

/** The levels of the one save. */
const sent = (calls: { key: string; body: unknown }[]) =>
  (saved(calls)[0] as { levels: Level[] } | undefined)?.levels ?? []

test('a cell, the default and the order are edited and saved as one set', async () => {
  const calls = fakeApi({
    ...signedIn(),
    'GET /api/admin/levels': { levels: shipped },
    'PUT /api/admin/levels': (init?: RequestInit) => new Response(init?.body as string),
  })
  renderAt('/admin/stufen', <App />)

  const save = await screen.findByRole('button', { name: 'Speichern' })
  expect(save).toBeDisabled()
  await userEvent.selectOptions(screen.getByLabelText('Darstellung – Automatisch'), 'approve')
  await userEvent.click(screen.getByLabelText('Voreingestellt – Assistenz'))
  await userEvent.click(screen.getByRole('button', { name: '„Automatisch" nach links' }))
  await userEvent.click(save)

  await vi.waitFor(() => expect(saved(calls)).toHaveLength(1))
  expect(sent(calls).map((l) => [l.id, l.is_default])).toEqual([
    [1, true],
    [3, false],
    [2, false],
  ])
  expect(sent(calls)[1]?.matrix).toMatchObject({ display: 'approve', query: 'auto' })
})

test('the stored default cannot be removed until another is saved as the default', async () => {
  fakeApi({ ...signedIn(), 'GET /api/admin/levels': { levels: shipped } })
  renderAt('/admin/stufen', <App />)

  const remove = await screen.findByRole('button', { name: '„Prüfen" entfernen' })
  expect(remove).toBeDisabled()
  expect(screen.getByRole('button', { name: '„Assistenz" entfernen' })).toBeEnabled()
  await userEvent.click(screen.getByLabelText('Voreingestellt – Assistenz'))
  expect(remove).toBeDisabled()
  expect(screen.getByRole('button', { name: '„Assistenz" entfernen' })).toBeDisabled()
})

test('a new level starts with everything off, and a fifth cannot be added', async () => {
  const calls = fakeApi({
    ...signedIn(),
    'GET /api/admin/levels': { levels: shipped },
    'PUT /api/admin/levels': (init?: RequestInit) => new Response(init?.body as string),
  })
  renderAt('/admin/stufen', <App />)

  const add = await screen.findByRole('button', { name: 'Stufe' })
  await userEvent.click(add)
  expect(add).toBeDisabled()
  expect(screen.getByLabelText('Abfragen und filtern – Neue Stufe')).toHaveValue('off')
  await userEvent.click(screen.getByRole('button', { name: '„Automatisch" entfernen' }))
  await userEvent.click(screen.getByRole('button', { name: 'Speichern' }))

  await vi.waitFor(() => expect(saved(calls)).toHaveLength(1))
  const levels = sent(calls)
  expect(levels.map((l) => l.name)).toEqual(['Assistenz', 'Prüfen', 'Neue Stufe'])
  expect(levels[2]).not.toHaveProperty('id')
  expect(levels[2]).not.toHaveProperty('key')
})

test('a refusal is shown by its code and the draft stays', async () => {
  fakeApi({
    ...signedIn(),
    'GET /api/admin/levels': { levels: shipped },
    'PUT /api/admin/levels': new Response(
      JSON.stringify({
        code: 'default_not_selectable',
        message: 'x',
        details: { name: 'Prüfen' },
      }),
      { status: 400 },
    ),
  })
  renderAt('/admin/stufen', <App />)

  await userEvent.click(await screen.findByLabelText('Für Anwender wählbar – Prüfen'))
  await userEvent.click(screen.getByRole('button', { name: 'Speichern' }))

  expect(
    await screen.findByText('Die voreingestellte Stufe „Prüfen" muss für Anwender wählbar sein.'),
  ).toBeInTheDocument()
  expect(screen.getByLabelText('Für Anwender wählbar – Prüfen')).not.toBeChecked()
  await userEvent.click(screen.getByRole('button', { name: 'Verwerfen' }))
  expect(screen.getByLabelText('Für Anwender wählbar – Prüfen')).toBeChecked()
})

test('the administration links to the levels', async () => {
  fakeApi({ ...signedIn(), 'GET /api/admin/levels': { levels: shipped } })
  renderAt('/admin/stufen', <App />)
  const nav = await screen.findByRole('navigation', { name: 'Administration' })
  expect(within(nav).getByRole('link', { name: 'Stufen' })).toHaveAttribute('href', '/admin/stufen')
})
