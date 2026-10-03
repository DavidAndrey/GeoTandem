import { expect, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test'

// Accounts of their own for tests that save: no other test lands in their
// sessions or sees their queries.

export const PASSWORD = 'vorfuehrung-passwort-1'

/** An account of its own, so that no other test lands in these sessions. */
export async function ensureAccount(
  admin: APIRequestContext,
  browser: Browser,
  username: string,
  role: 'admin' | 'user' = 'admin',
) {
  const users = (await (await admin.get('/api/admin/users')).json()) as { username: string }[]
  if (users.some((u) => u.username === username)) return
  const created = await admin.post('/api/admin/users', { data: { username, role } })
  expect(created.ok()).toBe(true)
  const { start_password } = await created.json()
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } })
  await context.request.post('/api/auth/login', { data: { username, password: start_password } })
  const changed = await context.request.post('/api/auth/password', {
    data: { current: start_password, new: PASSWORD },
  })
  expect(changed.ok()).toBe(true)
  await context.close()
}

/** A browser that has never seen this instance, signed in through the login page (design A2). */
export async function signIn(browser: Browser, username: string): Promise<[BrowserContext, Page]> {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } })
  const page = await context.newPage()
  await page.goto('/')
  await page.getByLabel('Benutzername').fill(username)
  await page.getByLabel('Passwort').fill(PASSWORD)
  await page.getByRole('button', { name: 'Anmelden' }).click()
  return [context, page]
}
