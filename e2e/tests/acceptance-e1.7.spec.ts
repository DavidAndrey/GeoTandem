import { expect, test, type APIRequestContext, type Page } from './test'
import { ensureAccount, signIn } from './accounts'
import { buildReferenceQuestion, ensureAreaLayer, validate, watchQueries } from './reference'

// Acceptance E1.7 (etappen.md): "Eine gespeicherte Sitzung liefert nach
// Neustart dasselbe Ergebnis." — and with it the Vorführung E1: a multi-layer
// question answered by hand, saved, and reproduced after a restart, without
// any LLM connection (F-4.11).
//
// The gate runs the suite twice, the second time after restarting the
// container on the same volume. The first pass builds and saves the session;
// every pass signs in fresh and must land in it, identical. With
// E2E_AFTER_RESTART set, the session must already exist: the second pass can
// only pass on what the first one saved.

test.describe.configure({ mode: 'serial' })

const DEMO = 'Vorführung E1'

async function sessionsOf(page: Page) {
  return (await (await page.request.get('/api/sessions')).json()) as {
    id: string
    name: string
    stamp: { count: number } | null
  }[]
}

test('Vorführung E1: answered by hand, saved, reproduced after a restart', async ({
  browser,
  request,
}) => {
  await ensureAreaLayer(request)
  await ensureAccount(request, browser, 'vorfuehrung')
  const [first, page] = await signIn(browser, 'vorfuehrung')
  const { sent, failures } = watchQueries(page)
  await expect(page.getByRole('button', { name: 'Sitzungsmenü' })).toBeVisible()
  const exists = (await sessionsOf(page)).some((s) => s.name === DEMO)
  if (process.env.E2E_AFTER_RESTART)
    expect(exists, 'the session of the first pass survives the restart').toBe(true)

  if (!exists) {
    // The question, by hand (E1.5) ...
    await buildReferenceQuestion(page)
    await expect(page.getByLabel('Trefferzahl')).toHaveText('10 von 137')
    // ... a buffer to see the roads' reach (F-4.5) ...
    const panel = page.getByRole('region', { name: 'Layer' })
    await panel.getByRole('button', { name: /^Strassen/, expanded: false }).click()
    await panel.getByRole('button', { name: 'Aktionen für Strassen' }).click()
    await page.getByRole('menuitem', { name: 'Puffer …' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Puffer anlegen' }).click()
    // ... its hits read in the table, sorted by name (E1.6) ...
    await page.getByRole('button', { name: 'Attributtabelle', exact: true }).click()
    const table = page.getByRole('table', { name: 'Attribute von Schulen' })
    await table.getByRole('columnheader', { name: /Schulname/ }).getByRole('button').click()
    await table.getByRole('columnheader', { name: /Schulname/ }).getByRole('button').click()
    await expect(table.getByRole('columnheader', { name: /Schulname/ })).toHaveAttribute(
      'aria-sort',
      'ascending',
    )
    await expect(page.getByRole('status', { name: 'Speicherstand' })).toHaveText(/ungespeichert/)

    // ... and saved (design C2): Ctrl+S on a new analysis asks for a name.
    await page.keyboard.press('Control+s')
    const dialog = page.getByRole('dialog', { name: 'Sitzung speichern' })
    await expect(dialog.getByText('10 Treffer')).toBeVisible()
    await dialog.getByLabel('Name').fill(DEMO)
    await dialog.getByLabel('Notiz (optional)').fill('Primarschulen an Kantonsstrassen B')
    await dialog.getByRole('button', { name: 'Speichern' }).click()
    await expect(page.getByRole('button', { name: 'Sitzungsmenü' })).toHaveText(DEMO)
    await expect(page.getByRole('status', { name: 'Speicherstand' })).toHaveText(/^gespeichert/)
    await expect(page).toHaveURL(/\/sitzung\//)
  }
  const saved = (await sessionsOf(page)).find((s) => s.name === DEMO)
  expect(saved?.stamp?.count).toBe(10)
  for (const query of sent) expect(validate(query), JSON.stringify(validate.errors)).toBe(true)
  expect(failures).toEqual([])
  await first.close()

  // Signed in afresh: the workplace lands in the last session and checks it (design A2, C4).
  const [second, again] = await signIn(browser, 'vorfuehrung')
  await expect(again.getByRole('button', { name: 'Sitzungsmenü' })).toHaveText(DEMO)
  await expect(again.getByRole('status', { name: 'Ergebnisprüfung' })).toHaveText(
    /Wiederhergestellt · 10 Treffer, identisch mit dem Speicherstand/,
  )
  await expect(again.getByLabel('Trefferzahl')).toHaveText('10 von 137')
  await expect(again.getByRole('status', { name: 'Speicherstand' })).toHaveText(/^gespeichert/)
  // Layers, the derived buffer and the table come back as saved.
  const panel = again.getByRole('region', { name: 'Layer' })
  await expect(panel.getByRole('heading', { name: 'Abgeleitet · Sitzung' })).toBeVisible()
  await again.getByRole('button', { name: 'Attributtabelle', exact: true }).click()
  const table = again.getByRole('table', { name: 'Attribute von Schulen' })
  await expect(table.locator('tbody tr[data-fid]')).toHaveCount(10)
  await expect(table.getByRole('columnheader', { name: /Schulname/ })).toHaveAttribute(
    'aria-sort',
    'ascending',
  )
  const names = await table.locator('tbody tr[data-fid] td:nth-child(2)').allTextContents()
  expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'de-CH')))
  // The server's own word on it, without any model (F-8.9, F-4.11).
  const check = await (await again.request.post(`/api/sessions/${saved?.id}/check`)).json()
  expect(check).toMatchObject({ identical: true, changed_layers: [], missing_layers: [] })
  await second.close()
})

/** Five points around Bern; ``count`` of them. */
function points(count: number): Buffer {
  const features = Array.from({ length: count }, (_, i) => ({
    type: 'Feature',
    properties: { name: `Punkt ${i + 1}` },
    geometry: { type: 'Point', coordinates: [7.43 + i * 0.01, 46.95] },
  }))
  return Buffer.from(JSON.stringify({ type: 'FeatureCollection', features }))
}

async function importPoints(admin: APIRequestContext, count: number, replace: boolean) {
  const upload = await admin.post('/api/admin/imports', {
    multipart: { file: { name: 'punkte.geojson', mimeType: 'application/geo+json', buffer: points(count) } },
  })
  const { import_id } = await upload.json()
  const run = await admin.post(`/api/admin/imports/${import_id}/commit`, {
    data: {
      geo: { mode: 'geometry', crs: 4326 },
      ...(replace
        ? { replace: 'e2e_datenstand' }
        : { layer_name: 'e2e_datenstand', title: 'E2E Datenstand' }),
    },
  })
  expect((await run.json()).status, 'import').toBe('ok')
}

test('a session on changed data says what changed (design C4)', async ({ browser, request }) => {
  const exists = (await request.get('/api/layers/e2e_datenstand')).ok()
  await importPoints(request, 3, exists)
  await ensureAccount(request, browser, 'datenstand')
  const [context, page] = await signIn(browser, 'datenstand')
  await expect(page.getByRole('button', { name: 'Sitzungsmenü' })).toBeVisible()

  // A session on the three points, saved through the API like the interface does.
  const body = {
    name: 'Datenstand',
    state_version: 1,
    state: {
      layers: [
        {
          id: 'e2e_datenstand',
          source: { kind: 'catalog', layer: 'e2e_datenstand' },
          visible: true,
          opacity: 1,
          symbology: null,
        },
      ],
      result: 'e2e_datenstand',
      tree: { id: 'root', kind: 'group', op: 'and', not: false, children: [] },
      restriction: null,
      table: { tab: null, mode: 'hits', onlyView: false, columns: {}, sort: {} },
      view: null,
    },
    query: { schema_version: '2', source: 'e2e_datenstand', output: 'map' },
  }
  const existing = (await sessionsOf(page)).find((s) => s.name === 'Datenstand')
  const saved = existing
    ? await page.request.put(`/api/sessions/${existing.id}`, { data: body })
    : await page.request.post('/api/sessions', { data: body })
  const session = await saved.json()
  expect(session.stamp.count).toBe(3)

  // The layer is updated: four points now (D4 "Aktualisieren").
  await importPoints(request, 4, true)
  await page.goto(`/sitzung/${session.id}`)
  const notice = page.getByRole('alert', { name: 'Ergebnisprüfung' })
  await expect(notice).toContainText('Ergebnis weicht ab: 3 → 4 Treffer')
  await expect(notice).toContainText('Layer „E2E Datenstand" hat eine neue Fassung')

  // Adopting the current data sets a new stamp.
  await notice.getByRole('button', { name: 'Mit aktuellen Daten übernehmen' }).click()
  await expect(notice).toBeHidden()
  const check = await (await page.request.post(`/api/sessions/${session.id}/check`)).json()
  expect(check).toMatchObject({ identical: true })
  expect(check.saved.count).toBe(4)
  await context.close()
})
