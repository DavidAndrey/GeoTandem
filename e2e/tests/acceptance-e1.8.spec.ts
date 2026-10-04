import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

// Acceptance E1.8 (docs/plan-e1.8.md): the same results on every backend for
// text (F-2.14), and the classic map tools and catalog extras built with it —
// map search, measuring, table layers in the attribute table, dates.

const run = Date.now().toString(36)

async function addLayers(page: Page, names: RegExp[]) {
  await page.getByRole('button', { name: 'Layer', exact: true }).click()
  const picker = page.getByRole('dialog', { name: 'Layer hinzufügen' })
  for (const name of names) await picker.getByRole('checkbox', { name }).first().check()
  await picker.getByRole('button', { name: 'Hinzufügen' }).click()
}

/** Opens the workplace and waits until its first view — fitted to the extent from
 * the map config — has settled; returns the scale bar's label and width then. */
async function openSettled(page: Page) {
  const config = page.waitForResponse((r) => r.url().endsWith('/api/config/map'))
  await page.goto('/')
  await config
  const scale = page.getByRole('region', { name: 'Karte' }).locator('.leaflet-control-scale-line')
  let last = ''
  let settled = { label: '', width: 0 }
  await expect
    .poll(
      async () => {
        await page.waitForTimeout(400)
        const label = (await scale.textContent()) ?? ''
        const width = (await scale.boundingBox())?.width ?? 0
        const now = `${label}|${width}`
        const same = label !== '' && now === last
        last = now
        settled = { label, width }
        return same
      },
      { timeout: 10_000 },
    )
    .toBe(true)
  return settled
}

const toMeters = (text: string) => {
  const [value, unit] = text.split(' ')
  return Number(value) * (unit === 'km' ? 1000 : 1)
}

test('search finds a name with an umlaut in any case, and zooms to it', async ({ page }) => {
  const before = await openSettled(page)
  const map = page.getByRole('region', { name: 'Karte' })
  await page.getByRole('button', { name: 'Suchen' }).click()
  const search = page.getByRole('search', { name: 'Kartensuche' })
  // "änggi" finds "Änggisteibach": case-insensitive for every letter (WP39).
  await search.getByLabel('Suchbegriff').fill('änggi')
  const rivers = search.getByRole('region', { name: 'Gewässer' })
  // The river has more than one section with that name; any of them will do.
  await rivers.getByRole('button', { name: 'Änggisteibach' }).first().click()
  // Not on the map as a layer: marked with its name, and zoomed to.
  await expect(map.locator('.leaflet-tooltip')).toHaveText('Änggisteibach')
  await expect(map.locator('.leaflet-control-scale-line')).not.toHaveText(before.label)
  await search.getByRole('button', { name: 'Suche schliessen' }).click()
  await expect(map.locator('.leaflet-tooltip')).toHaveCount(0)
})

test('a measured distance matches the map scale', async ({ page }) => {
  // The scale bar: a known number of pixels for a known distance.
  const { label, width } = await openSettled(page)
  const meters = toMeters(label)
  expect(meters).toBeGreaterThan(0)
  const map = page.getByRole('region', { name: 'Karte' })

  await page.getByRole('button', { name: 'Messen' }).click()
  const box = (await map.boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 }
  const y = box.y + box.height / 2
  const x = box.x + box.width / 2 - width / 2
  await page.mouse.click(x, y)
  await page.mouse.dblclick(x + width, y)
  const readout = page.getByRole('status', { name: 'Messwert' })
  // The scale is taken at the map's centre line; the geodesic agrees within 2 %.
  await expect
    .poll(async () => Math.abs(toMeters((await readout.textContent()) ?? '') - meters) / meters)
    .toBeLessThan(0.02)

  // Escape clears the drawing, a second one ends measuring.
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('region', { name: 'Messen' })).toHaveCount(0)
})

test('a table layer is read in the attribute table, never drawn', async ({ page }) => {
  await page.goto('/')
  await addLayers(page, [/^Gemeinden$/, /^Gemeindedaten/])
  const panel = page.getByRole('region', { name: 'Layer' })
  // Both rows are there, with their titles from the catalog: only the drawn one
  // can be shown or hidden.
  await expect(panel.getByRole('button', { name: /^Gemeindedaten/ })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Gemeinden ausblenden' })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Gemeindedaten ausblenden' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Attributtabelle', exact: true }).click()
  const dock = page.getByRole('region', { name: 'Attributtabelle' })
  await dock.getByRole('tab', { name: 'Gemeindedaten' }).click()
  const table = dock.getByRole('table', {
    name: 'Attribute von Gemeindedaten',
  })
  await expect(table.locator('tbody tr[data-fid]').first()).toBeVisible()
  // Never the result layer: the municipalities stay it.
  await expect(dock.getByRole('tab', { name: /Gemeinden.*Ergebnis/ })).toBeVisible()
})

async function importDates(request: APIRequestContext, name: string) {
  const csv = [
    'nr;kontrolle;e;n',
    '1;01.03.2024;2600000;1200000',
    '2;15.11.2023;2601000;1200000',
    '3;;2602000;1200000',
    '4;29.02.2024;2603000;1200000',
  ].join('\n')
  const staged = await request.post('/api/admin/imports', {
    multipart: {
      file: {
        name: `${name}.csv`,
        mimeType: 'text/csv',
        buffer: Buffer.from(csv),
      },
    },
  })
  const { import_id } = await staged.json()
  const run = await request.post(`/api/admin/imports/${import_id}/commit`, {
    data: {
      layer_name: name,
      title: `Kontrollen ${name}`,
      geo: { mode: 'xy', x: 'e', y: 'n', crs: 2056 },
      fields: [{ source_name: 'kontrolle', label: 'Kontrolle' }],
    },
  })
  expect((await run.json()).status).toBe('ok')
}

test('a date column filters by date in the editor', async ({ page, request }) => {
  const name = `kontrollen_${run}_${test.info().repeatEachIndex}`
  await importDates(request, name)
  const info = await (await request.get(`/api/layers/${name}`)).json()
  expect(info.attributes.find((a: { name: string }) => a.name === 'kontrolle').data_type).toBe(
    'date',
  )

  await page.goto('/')
  await addLayers(page, [new RegExp(`^Kontrollen ${name}`)])
  await page.getByRole('button', { name: '+ Bedingung' }).click()
  const editor = page.getByRole('region', { name: 'Abfrage-Editor' })
  const row = editor.getByRole('group', { name: 'Bedingung Attribut' })
  await row.getByLabel('Feld').selectOption({ label: 'Kontrolle' })
  await row.getByLabel('Operator').selectOption({ label: 'ab' })
  await row.getByLabel('Wert').fill('2024-01-01')
  await editor.getByRole('button', { name: 'Übernehmen' }).click()
  // 1.3.2024 and 29.2.2024; the empty one and 2023 are not.
  await expect(page.getByLabel('Trefferzahl')).toHaveText('2 von 4')
  await expect(page.getByLabel('Bedingungen (Übersicht)')).toContainText('Kontrolle ab 01.01.2024')
})
