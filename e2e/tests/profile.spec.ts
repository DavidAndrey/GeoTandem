import { expect, test } from './test'

// What the model sees (plan E2.2, S6), on the real sample: metadata only.

test('the profile for the administrator lists the sample layers without counts', async ({
  page,
}) => {
  await page.goto('/admin/steckbrief')
  await page.getByLabel('Konto').selectOption('admin')
  await expect(page.getByRole('region', { name: 'Schulen' })).toBeVisible()
  await expect(page.getByText(/^[0-9a-f]{64}$/)).toBeVisible()
  await page.getByText('Als JSON').click()
  const json = await page.locator('pre').innerText()
  expect(json).toContain('"profile_version": 1')
  expect(json).not.toContain('feature_count')
  expect(json).not.toContain('bbox')
})
