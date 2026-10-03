import { expect, test, type Browser, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FILES_DIR } from '../global-setup'

// Acceptance E1.4 (etappen.md): two accounts with different roles see
// different layers, in the interface and at the API.

test.describe.configure({ mode: 'serial' })

const run = `acc${Date.now().toString(36)}`
const username = `anw.${run}`
const hiddenLayer = `e2e_${run}_verdeckt`
const hiddenTitle = `Verdeckt ${run}`
const userPassword = 'anwender-passwort-1'

/** A browser without the administrator's session. */
async function freshPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } })
  return context.newPage()
}

async function signIn(page: Page, name: string, password: string) {
  await page.goto('/anmelden')
  await page.getByLabel('Benutzername').fill(name)
  await page.getByLabel('Passwort').fill(password)
  await page.getByRole('button', { name: 'Anmelden' }).click()
}

let startPassword = ''

test('admin imports a layer, which starts hidden for users', async ({ request }) => {
  const staged = await request.post('/api/admin/imports', {
    multipart: {
      file: {
        name: 'schulen.geojson',
        mimeType: 'application/geo+json',
        buffer: readFileSync(join(FILES_DIR, 'schulen.geojson')),
      },
    },
  })
  expect(staged.ok()).toBeTruthy()
  const { import_id } = await staged.json()
  const committed = await request.post(`/api/admin/imports/${import_id}/commit`, {
    data: { layer_name: hiddenLayer, title: hiddenTitle },
  })
  expect((await committed.json()).status).toBe('ok')
})

test('admin creates an account in the user administration', async ({ page }) => {
  await page.goto('/admin/benutzer')
  await page.getByRole('button', { name: 'Konto' }).click()
  const form = page.getByRole('form', { name: 'Neues Konto' })
  await form.getByLabel('Benutzer').fill(username)
  await form.getByLabel('Name').fill('Mara Keller')
  await form.getByRole('button', { name: 'Anlegen' }).click()
  startPassword = (await page.getByLabel('Startpasswort').textContent()) ?? ''
  expect(startPassword.length).toBeGreaterThanOrEqual(10)
  await expect(page.getByRole('cell', { name: username, exact: true })).toBeVisible()
})

test('the user sets a password and sees the released layers only', async ({ browser }) => {
  const page = await freshPage(browser)
  await signIn(page, username, startPassword)
  await expect(page.getByRole('heading', { name: 'Passwort festlegen' })).toBeVisible()
  await page.getByLabel('Aktuelles Passwort').fill(startPassword)
  await page.getByLabel('Neues Passwort', { exact: true }).fill(userPassword)
  await page.getByLabel('Neues Passwort wiederholen').fill(userPassword)
  await page.getByRole('button', { name: 'Passwort ändern' }).click()

  const layers = page.getByRole('region', { name: 'Verfügbare Layer' })
  await expect(layers.getByText('Schulen', { exact: true })).toBeVisible()
  await expect(layers.getByText(hiddenTitle)).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Administration' })).toHaveCount(0)

  // The API says the same, whatever the interface shows.
  const query = await page.request.post('/api/query', { data: { source: hiddenLayer } })
  expect(query.status()).toBe(400)
  expect((await query.json()).code).toBe('unknown_layer')
  expect((await page.request.get('/api/admin/layers')).status()).toBe(403)
  await page.context().close()
})

test('the admin sees the hidden layer and releases it', async ({ page }) => {
  await page.goto('/')
  const layers = page.getByRole('region', { name: 'Verfügbare Layer' })
  await expect(layers.getByText(hiddenTitle)).toBeVisible()
  await page.goto('/admin/sichtbarkeit')
  const box = page.getByRole('checkbox', { name: `${hiddenTitle} für Anwender` })
  await expect(box).not.toBeChecked()
  const saved = page.waitForResponse(
    (r) => r.url().endsWith('/api/admin/visibility') && r.request().method() === 'PUT',
  )
  await box.click()
  expect((await saved).ok()).toBeTruthy()
  await page.reload()
  await expect(box).toBeChecked() // stored, not just shown
})

test('after release the user sees it too', async ({ browser }) => {
  const page = await freshPage(browser)
  await signIn(page, username, userPassword)
  const layers = page.getByRole('region', { name: 'Verfügbare Layer' })
  await expect(layers.getByText(hiddenTitle)).toBeVisible()
  await page.context().close()
})

test('signing out ends the session', async ({ browser }) => {
  const page = await freshPage(browser)
  await signIn(page, username, userPassword)
  await page.getByRole('button', { name: 'Benutzermenü' }).click()
  await page.getByRole('menuitem', { name: 'Abmelden' }).click()
  await expect(page.getByRole('heading', { name: 'Anmelden' })).toBeVisible()
  expect((await page.request.get('/api/layers')).status()).toBe(401)
  await page.context().close()
})
