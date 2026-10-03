import { expect, test } from '@playwright/test'

// Workplace (design B1, F-4.1, F-4.9, F-8.1): layers from the catalog on the
// map, in panel order, with popups. The reference question follows in E1.5 WP25.

test('layers from the picker appear on the map with popups', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Layer', exact: true }).click()
  const picker = page.getByRole('dialog', { name: 'Layer hinzufügen' })
  await picker.getByRole('checkbox', { name: /^Schulen/ }).check()
  await picker.getByRole('checkbox', { name: /^Gemeinden/ }).check()
  await picker.getByRole('button', { name: 'Hinzufügen' }).click()

  await expect(page.getByLabel('Trefferzahl')).toHaveText('137 von 137')
  const map = page.getByRole('region', { name: 'Karte' })
  // 137 school markers plus 74 municipalities.
  await expect(map.locator('path.leaflet-interactive')).toHaveCount(211)

  await map.locator('.leaflet-pane[class*="layer-schulen"] path.leaflet-interactive').first().click({ force: true })
  await expect(page.locator('.leaflet-popup')).toContainText('Schulen')

  await page.getByRole('button', { name: 'Gemeinden ausblenden' }).click()
  await expect(map.locator('path.leaflet-interactive')).toHaveCount(137)

  const legend = page.getByRole('region', { name: 'Legende' })
  await expect(legend).toContainText('Schulen')
  await expect(legend).not.toContainText('Gemeinden')
})
