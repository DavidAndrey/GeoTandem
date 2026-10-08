import { expect, test } from './test'

// Model connections (plan E2.1, WP58) against the real container: a
// connection to an address where nothing listens fails its test at the
// reachability step, worded by code, and the result stays with it.

test.describe.configure({ mode: 'serial' })

const NAME = `e2e-anbindung-${Date.now().toString(36)}`

test('a connection is created, tested and shows its failed step', async ({ page, request }) => {
  try {
    await page.goto('/admin/modelle')
    await page.getByRole('button', { name: 'Anbindung', exact: true }).click()
    const form = page.getByRole('form', { name: 'Neue Anbindung' })
    await form.getByLabel('Name').fill(NAME)
    await form.getByLabel('Adresse').fill('http://127.0.0.1:9/v1')
    await form.getByLabel('Modell').fill('qwen3:8b')

    await form.getByRole('button', { name: 'Verbindung testen' }).click()
    const draft = page.getByRole('region', { name: 'Ergebnis des Verbindungstests' })
    await expect(draft.getByText('Verbindungstest nicht bestanden')).toBeVisible()
    await expect(draft.getByText('Das Modell ist nicht erreichbar.')).toBeVisible()

    await form.getByRole('button', { name: 'Speichern' }).click()
    const row = page.getByRole('row', { name: new RegExp(NAME) })
    await expect(row.getByText('lokal')).toBeVisible()
    await expect(row.getByText('nicht freigegeben')).toBeVisible()

    await row.getByRole('button', { name: `Aktionen für ${NAME}` }).click()
    await page.getByRole('menuitem', { name: 'Verbindung testen' }).click()
    await expect(page.getByRole('region', { name: `Verbindungstest „${NAME}"` })).toBeVisible()
    await expect(row.getByText('nicht bestanden')).toBeVisible()
  } finally {
    const all = (await (await request.get('/api/admin/llm/connections')).json()) as {
      id: number
      name: string
    }[]
    for (const c of all.filter((c) => c.name === NAME))
      await request.delete(`/api/admin/llm/connections/${c.id}`)
  }
})
