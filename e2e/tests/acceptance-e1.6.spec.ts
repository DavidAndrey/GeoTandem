import { expect, test, type Locator } from './test'
import { buildReferenceQuestion, ensureAreaLayer, validate, watchQueries } from './reference'

// Acceptance E1.6 (etappen.md): "Treffer lassen sich lesen und nicht nur
// zählen." The hits of the reference question in the attribute table (F-8.2,
// design B8): sorted, with chosen columns, highlighted on the map, and with the
// computed columns that show why each school is a hit (plan E1.6, S4).

const headers = (table: Locator) => table.getByRole('columnheader').allTextContents()

test('the hits of the reference question can be read, not just counted', async ({
  page,
  request,
}) => {
  await ensureAreaLayer(request)
  const { sent, failures } = watchQueries(page)
  await buildReferenceQuestion(page)
  await expect(page.getByLabel('Trefferzahl')).toHaveText('10 von 137')

  // B3 "Tabelle öffnen" on the result layer.
  const panel = page.getByRole('region', { name: 'Layer' })
  await panel.getByRole('button', { name: /^Schulen/, expanded: false }).click()
  await panel.getByRole('button', { name: 'Aktionen für Schulen' }).click()
  await page.getByRole('menuitem', { name: 'Tabelle öffnen' }).click()
  const dock = page.getByRole('region', { name: 'Attributtabelle' })
  const table = dock.getByRole('table', { name: 'Attribute von Schulen' })
  const rows = table.locator('tbody tr[data-fid]')

  // The ten hits, with the columns that explain them.
  await expect(dock.getByRole('button', { name: 'Treffer (10)' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(rows).toHaveCount(10)
  expect(await headers(table)).toEqual([
    '',
    'Schulname',
    'Gemeindenummer',
    'Höchste Schulstufe',
    'Mit Kindergarten',
    'Mit Primarstufe',
    'Mit Sekundarstufe I',
    'Unterrichtssprache',
    'Anzahl Schulhäuser',
    'Distanz Strassen',
    'Steueranlage (Steuern je Gemeinde)',
    'Zoomen',
  ])

  // The distances are the engine's: the same query object, asked directly.
  // The last query for the result layer is the one the table shows.
  const shown = sent.findLast(
    (q) =>
      (q as { source?: string; columns?: unknown[] }).source === 'schulen' &&
      Boolean((q as { columns?: unknown[] }).columns),
  )
  expect(shown).toBeDefined()
  const answer = await (await request.post('/api/query', { data: shown })).json()
  const distance = new Map<number, number>(
    answer.features.map((f: { id: number; properties: Record<string, number> }) => [
      f.id,
      f.properties.calc_distanz_strassen_klasse,
    ]),
  )
  const column = (await headers(table)).indexOf('Distanz Strassen')
  for (const row of await rows.all()) {
    const fid = Number(await row.getAttribute('data-fid'))
    const value = distance.get(fid)
    expect(value).toBeLessThanOrEqual(500) // the condition: ≤ 500 m to a cantonal road B
    await expect(row.getByRole('cell').nth(column)).toHaveText(`${Math.round(value ?? NaN)} m`)
  }

  // Sorted by school buildings ↓, then (Shift) by name.
  const buildings = table.getByRole('columnheader', { name: /Anzahl Schulhäuser/ })
  await buildings.getByRole('button').click()
  await table
    .getByRole('columnheader', { name: /Schulname/ })
    .getByRole('button')
    .click({ modifiers: ['Shift'] })
  await expect(buildings).toHaveAttribute('aria-sort', 'descending')
  const counts = (await rows.locator('td:nth-child(9)').allTextContents()).map((t) => parseInt(t))
  expect(counts).toEqual([...counts].sort((a, b) => b - a))

  // Columns: one hidden, the distance moved first.
  await dock.getByRole('button', { name: /Spalten/ }).click()
  const menu = page.getByRole('dialog', { name: 'Spalten' })
  await expect(menu.getByText('berechnet')).toBeVisible()
  await menu.getByRole('checkbox', { name: 'Höchste Schulstufe' }).uncheck()
  for (let i = 0; i < 8; i++)
    await menu.getByRole('button', { name: 'Distanz Strassen nach oben' }).click()
  await page.keyboard.press('Escape')
  // "2": Schulname is the second sort key.
  expect((await headers(table)).slice(1, 3)).toEqual(['Distanz Strassen', 'Schulname2'])

  // Row → map, and back.
  const map = page.getByRole('region', { name: 'Karte' })
  const ring = map.locator('.leaflet-pane[class*="layer-schulen"] path[stroke-dasharray="3 3"]')
  await rows.first().click()
  await expect(ring).toHaveCount(1)
  await expect(rows.first()).toHaveAttribute('aria-selected', 'true')

  // Every query on the way was valid and accepted (etappen E1.5 still holds).
  for (const query of sent) expect(validate(query), JSON.stringify(validate.errors)).toBe(true)
  expect(failures).toEqual([])
})
