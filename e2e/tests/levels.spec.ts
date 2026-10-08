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
    // Wait for the save itself: the button is disabled while it is still in flight,
    // and a reload then can overtake it.
    const saved = page.waitForResponse(
      (r) => r.url().endsWith('/api/admin/levels') && r.request().method() === 'PUT',
    )
    await page.getByRole('button', { name: 'Speichern' }).click()
    expect((await saved).ok()).toBe(true)
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

test('a user cannot choose a level closed to users through the API', async ({
  browser,
  request,
}) => {
  const { levels } = await (await request.get('/api/admin/levels')).json()
  const closed = levels.find((l: { selectable: boolean }) => !l.selectable)
  const open = levels.find((l: { selectable: boolean }) => l.selectable)
  await ensureAccount(request, browser, USER, 'user')
  const [context, page] = await signIn(browser, USER)
  await expect(page.getByRole('button', { name: 'Sitzungsmenü' })).toBeVisible()

  const refused = await context.request.put('/api/llm/options', { data: { level_id: closed.id } })
  expect(refused.status()).toBe(400)
  expect((await refused.json()).code).toBe('level_not_available')
  const options = await (await context.request.get('/api/llm/options')).json()
  expect(options.levels.map((l: { id: number }) => l.id)).not.toContain(closed.id)

  const chosen = await context.request.put('/api/llm/options', { data: { level_id: open.id } })
  expect((await chosen.json()).active_level_id).toBe(open.id)
  await context.request.put('/api/llm/options', { data: { level_id: null } })
  await context.close()
})

test('without an enabled connection the workplace header says so', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText(/^Keine Modellanbindung eingerichtet/)).toBeVisible()
})
