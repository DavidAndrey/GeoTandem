import { expect, test } from '@playwright/test'

// Attribute table (F-8.2, design B8, B9): highlighting in both directions
// between table and map.

test('table and map highlight each other', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Layer', exact: true }).click()
  const picker = page.getByRole('dialog', { name: 'Layer hinzufügen' })
  await picker.getByRole('checkbox', { name: /^Schulen/ }).check()
  await picker.getByRole('checkbox', { name: /^Strassen/ }).check()
  await picker.getByRole('button', { name: 'Hinzufügen' }).click()
  await expect(page.getByLabel('Trefferzahl')).toHaveText('120 von 120')

  await page.getByRole('button', { name: 'Attributtabelle', exact: true }).click()
  const dock = page.getByRole('region', { name: 'Attributtabelle' })
  const schools = dock.getByRole('table', { name: 'Attribute von Schulen' })
  await expect(schools).toBeVisible()

  // Row → map: the feature gets the dashed selection ring.
  const map = page.getByRole('region', { name: 'Karte' })
  const pane = map.locator('.leaflet-pane[class*="layer-schulen"]')
  await schools.getByRole('row').nth(3).click()
  await expect(pane.locator('path[stroke-dasharray="3 3"]')).toHaveCount(1)
  await expect(dock.getByText('1 ausgewählt')).toBeVisible()

  // Map → row: from another tab, the click opens the school's tab and its row.
  await dock.getByRole('tab', { name: 'Strassen' }).click()
  await pane.locator('path.leaflet-interactive').nth(100).click({ force: true })
  await expect(dock.getByRole('tab', { name: /Schulen/ })).toHaveAttribute('aria-selected', 'true')
  const selected = schools.locator('tr[aria-selected="true"]')
  await expect(selected).toHaveCount(1)
  await expect(selected).toBeInViewport()
  await expect(page.locator('.leaflet-popup')).toContainText('Schulen')
  await expect(pane.locator('path[stroke-dasharray="3 3"]')).toHaveCount(1)

  // ⌖ zooms to the feature.
  const before = await map.locator('.leaflet-control-scale-line').textContent()
  await selected.getByRole('button', { name: /zoomen/ }).click()
  await expect(map.locator('.leaflet-control-scale-line')).not.toHaveText(before ?? '')
})
