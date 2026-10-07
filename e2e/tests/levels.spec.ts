import { expect, test } from './test'
import { ensureAccount, signIn } from './accounts'

// Levels of model support (plan E2.0, WP55): the administrator edits the set
// on the page; it survives a reload, and only administrators reach it.

test.describe.configure({ mode: 'serial' })

const USER = 'e2e.stufen'

test('an edited cell is saved and survives a reload', async ({ page, request }) => {
  const before = await (await request.get('/api/admin/levels')).json()
  try {
    await page.goto('/admin/stufen')
    const cell = page.getByLabel('Darstellung – Assistenz')
    await expect(cell).toHaveValue('off')
    await cell.selectOption('auto')
    await page.getByRole('button', { name: 'Speichern' }).click()
    await expect(page.getByRole('button', { name: 'Speichern' })).toBeDisabled()

    await page.reload()
    await expect(page.getByLabel('Darstellung – Assistenz')).toHaveValue('auto')
    await expect(page.getByLabel('Voreingestellt – Prüfen')).toBeChecked()
  } finally {
    // The instance is shared with other specs: put the shipped set back.
    const restored = await request.put('/api/admin/levels', { data: before })
    expect(restored.ok(), await restored.text()).toBe(true)
  }
})

test('the backend refuses a set without a selectable default', async ({ request }) => {
  const { levels } = await (await request.get('/api/admin/levels')).json()
  const closed = levels.map((l: { is_default: boolean }) =>
    l.is_default ? { ...l, selectable: false } : l,
  )
  const response = await request.put('/api/admin/levels', {
    data: { levels: closed },
  })
  expect(response.status()).toBe(400)
  expect((await response.json()).code).toBe('default_not_selectable')
})

test('a user reaches neither the page nor the API', async ({ browser, request }) => {
  await ensureAccount(request, browser, USER, 'user')
  const [context, page] = await signIn(browser, USER)
  await expect(page.getByRole('button', { name: 'Sitzungsmenü' })).toBeVisible()
  expect((await context.request.get('/api/admin/levels')).status()).toBe(403)
  await page.goto('/admin/stufen')
  await expect(page.getByRole('heading', { name: 'Stufen der Modellunterstützung' })).toHaveCount(0)
  await context.close()
})
