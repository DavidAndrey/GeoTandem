import { expect, test, type Page } from '@playwright/test'

// Query editor (design B2, F-4.2 to F-4.4) against the real engine: what the
// interface counts equals what the hand-written query object counts.

async function addLayers(page: Page, names: RegExp[]) {
  await page.getByRole('button', { name: 'Layer', exact: true }).click()
  const picker = page.getByRole('dialog', { name: 'Layer hinzufügen' })
  for (const name of names) await picker.getByRole('checkbox', { name }).first().check()
  await picker.getByRole('button', { name: 'Hinzufügen' }).click()
}

const reference = {
  schema_version: '2',
  source: 'schulen',
  where: {
    op: 'and',
    args: [
      { op: 'in', attr: 'typ', values: ['primar'] },
      {
        op: 'related',
        layer: 'strassen',
        predicate: 'dwithin',
        distance_m: 500,
        where: { op: 'compare', attr: 'klasse', cmp: 'eq', value: 'kantonsstrasse_b' },
      },
    ],
  },
}

test('conditions built by hand count like the hand-written query', async ({ page }) => {
  await page.goto('/')
  await addLayers(page, [/^Schulen/, /^Strassen/, /^Gemeinden/])
  await expect(page.getByLabel('Trefferzahl')).toHaveText('137 von 137')

  await page.getByRole('button', { name: '+ Bedingung' }).click()
  const editor = page.getByRole('region', { name: 'Abfrage-Editor' })
  const row = editor.getByRole('group', { name: 'Bedingung Attribut' })
  await row.getByLabel('Feld').selectOption({ label: 'Höchste Schulstufe' })
  await row.getByLabel('Operator').selectOption({ label: 'ist eins von' })
  await row.getByLabel('Wert hinzufügen').fill('primar')
  await row.getByLabel('Wert hinzufügen').press('Enter')

  await editor.getByRole('button', { name: 'Bedingung', exact: true }).first().click()
  await page.getByRole('menuitem', { name: 'Raum' }).click()
  const spatial = editor.getByRole('group', { name: 'Bedingung Raum' })
  await spatial.getByLabel('Beziehung').selectOption({ label: '≤ Distanz zu' })
  await spatial.getByLabel('Distanz in Metern').fill('500')
  await spatial.getByLabel('Bezugslayer').selectOption({ label: 'Strassen' })
  await spatial.getByRole('button', { name: '+ Filter' }).click()
  await spatial.getByLabel('Feld').selectOption({ label: 'Strassenklasse' })
  await spatial.getByLabel('Wert').fill('kantonsstrasse_b')
  await editor.getByRole('button', { name: 'Übernehmen' }).click()

  const expected = await page.request.post('/api/query/count', {
    data: { queries: [reference, { schema_version: '2', source: 'schulen' }] },
  })
  const [hits, total] = (await expected.json()).counts
  expect(hits).toBeGreaterThan(0)
  await expect(page.getByLabel('Trefferzahl')).toHaveText(`${hits} von ${total}`)

  // "Nur in: Ausschnitt" narrows the same query to the map view (F-4.3).
  await page.getByRole('button', { name: 'Hineinzoomen' }).click()
  await page.getByRole('button', { name: 'Hineinzoomen' }).click()
  const restricted = page.waitForRequest(
    (r) => r.url().endsWith('/api/query/count') && (r.postData() ?? '').includes('"op":"bbox"'),
  )
  await page.getByRole('button', { name: 'Ausschnitt' }).click()
  await restricted
  await expect(page.getByRole('button', { name: 'Ausschnitt' })).toHaveAttribute('aria-pressed', 'true')
})

test('a reference feature is picked on the map (F-4.3)', async ({ page }) => {
  await page.goto('/')
  await addLayers(page, [/^Schulen/, /^Gemeinden/])
  await page.getByRole('button', { name: 'Bearbeiten ›' }).click()
  const editor = page.getByRole('region', { name: 'Abfrage-Editor' })
  await editor.getByRole('button', { name: 'Bedingung', exact: true }).first().click()
  await page.getByRole('menuitem', { name: 'Bezugsobjekt' }).click()
  const row = editor.getByRole('group', { name: 'Bedingung Bezug' })
  await row.getByLabel('Layer des Bezugsobjekts').selectOption({ label: 'Gemeinden' })
  await row.getByRole('button', { name: 'Objekt wählen' }).click()
  await page
    .getByRole('region', { name: 'Karte' })
    .locator('.leaflet-pane[class*="layer-gemeinden"] path.leaflet-interactive')
    .first()
    .click({ force: true })
  await expect(row.locator('button.chip')).not.toHaveText('Objekt wählen')
  await expect(row.getByLabel('Treffer dieser Bedingung')).not.toHaveText('–')
})
