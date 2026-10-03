import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

// Smoke test for E1.1/E1.2. The E1 demonstration script (etappen.md 3)
// replaces the UI part once the map exists (E1.5).

const golden = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../backend/tests/golden/${name}`, import.meta.url), 'utf-8'))

test('the application starts and reports a ready data core', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveTitle('GeoTandem')
  await expect(page.getByRole('region', { name: 'Karte' })).toBeVisible()
  await page.goto('/admin/system')
  const status = page.getByRole('region', { name: 'Systemstatus' })
  await expect(status).toContainText('Bereit')
  await expect(status).toContainText('spatialite')
  await expect(status).toContainText('bern-mittelland-')
})

test('client-side routes are served by the same process', async ({ page }) => {
  await page.goto('/admin')
  await expect(page.getByRole('heading', { name: 'Administration' })).toBeVisible()
})

test('a hand-written query object gives the pinned result', async ({ request }) => {
  const query = golden('schools_near_river.query.json')
  const expected = golden('schools_near_river.expected.json')
  const response = await request.post('/api/query', { data: query })
  expect(response.ok(), `${response.status()} ${await response.text()}`).toBeTruthy()
  const body = await response.json()
  expect(body.meta.query_hash).toBe(expected.query_hash)
  expect(body.features.map((f: { id: number }) => f.id)).toEqual(
    expected.features.map((f: { id: number }) => f.id),
  )
})
