import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'

// Operations (design B4–B7, F-4.5 to F-4.8) as derived layers, against the real engine.

const golden = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../backend/tests/golden/${name}`, import.meta.url), 'utf-8'))

async function addLayers(page: Page, names: RegExp[]) {
  await page.getByRole('button', { name: 'Layer', exact: true }).click()
  const picker = page.getByRole('dialog', { name: 'Layer hinzufügen' })
  for (const name of names) await picker.getByRole('checkbox', { name }).first().check()
  await picker.getByRole('button', { name: 'Hinzufügen' }).click()
}

async function layerMenu(page: Page, title: string) {
  const panel = page.getByRole('region', { name: 'Layer' })
  await panel.getByRole('button', { name: new RegExp(`^${title}`), expanded: false }).click()
  await panel.getByRole('button', { name: `Aktionen für ${title}` }).click()
}

test('buffer, join and aggregation become derived layers', async ({ page }) => {
  await page.goto('/')
  await addLayers(page, [/^Gemeinden/, /^Schulen/, /^Gewässer$/])
  const map = page.getByRole('region', { name: 'Karte' })
  const derived = page.getByRole('region', { name: 'Layer' }).getByRole('heading', { name: 'Abgeleitet · Sitzung' })

  // Buffer (B4): two rivers, two buffer areas.
  await layerMenu(page, 'Gewässer')
  await page.getByRole('menuitem', { name: 'Puffer …' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Puffer anlegen' }).click()
  await expect(derived).toBeVisible()
  await expect(map.locator('.leaflet-pane[class*="layer-d"] path.leaflet-interactive')).toHaveCount(2)

  // Aggregation (B6): one feature per municipality, classified (B7) with a legend.
  await layerMenu(page, 'Schulen')
  await page.getByRole('menuitem', { name: 'Aggregieren …' }).click()
  await page.getByRole('dialog').getByLabel('Gebietslayer').selectOption({ label: 'Gemeinden' })
  await page.getByRole('dialog').getByRole('button', { name: 'Aggregieren' }).click()
  await expect(page.getByRole('region', { name: 'Legende' })).toContainText('Schulen je Gemeinden')
  await expect(page.getByRole('region', { name: 'Legende' }).getByText(/\d+ – \d+/).first()).toBeVisible()

  // Join (B5), then as result layer with a condition on a joined field:
  // the same features as the hand-written reference query.
  await layerMenu(page, 'Gemeinden')
  await page.getByRole('menuitem', { name: 'Join …' }).click()
  const join = page.getByRole('dialog')
  await join.getByLabel('Tabelle', { exact: true }).selectOption({ label: 'Bevölkerung (Tabelle)' })
  await join.getByRole('checkbox', { name: 'Einwohner' }).check()
  await join.getByRole('checkbox', { name: /Anteil unter 20/ }).check()
  await expect(join.getByLabel('Trefferquote')).toHaveText('12 / 12 Objekte finden einen Partner')
  await join.getByRole('button', { name: 'Join anlegen' }).click()

  await page.getByLabel('Ergebnis-Layer').selectOption({ label: 'Gemeinden + Bevölkerung' })
  await page.getByRole('button', { name: '+ Bedingung' }).click()
  const row = page.getByRole('region', { name: 'Abfrage-Editor' }).getByRole('group', { name: 'Bedingung Attribut' })
  await row.getByLabel('Feld').selectOption({ label: 'Einwohner' })
  await row.getByLabel('Operator').selectOption({ label: '≥' })
  await row.getByLabel('Wert').fill('6000')
  await page.getByRole('button', { name: 'Übernehmen' }).click()

  const reference = golden('large_municipalities.expected.json').features.length
  await expect(page.getByLabel('Trefferzahl')).toHaveText(`${reference} von 12`)
})
