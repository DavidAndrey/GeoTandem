import { expect, test } from './test'
import { ensureAccount, signIn } from './accounts'

// Acceptance E2.0–E2.2 (etappen.md 4, docs/plan-e2.0-e2.2.md):
//
// E2.0 — the levels are named, described and their allowed behaviour fixed.
// E2.1 — a local model is connected, its connection test is green, and the
//        application works without an outgoing internet connection (F-9.1).
//        The green test needs a model: E2E_LLM_URL (as the container reaches
//        it) and E2E_LLM_MODEL. `GATE_LLM_MODEL=… make gate` sets both, with
//        an Ollama container next to the application on a network without a
//        route out: every gate pass is the offline proof, this test the green
//        one (scripts/gate.sh). Below the container, backend/tests/
//        test_offline.py guards the sockets, with a positive control.
// E2.2 — the model knows layers and attributes without seeing data contents (F-9.3).

test.describe.configure({ mode: 'serial' })

const USER = 'e2e.abnahme.e2'
const CLASSES = ['catalog', 'query', 'spatial', 'derive', 'display']

test('E2.0: the shipped levels are named, described and fixed per operation class', async ({
  page,
  request,
}) => {
  const { levels } = await (await request.get('/api/admin/levels')).json()
  expect(
    levels.map((l: { name: string; selectable: boolean; is_default: boolean }) => [
      l.name,
      l.selectable,
      l.is_default,
    ]),
  ).toEqual([
    ['Assistenz', true, false],
    ['Prüfen', true, true],
    ['Automatisch', false, false],
  ])
  for (const level of levels) {
    expect(level.description).not.toBe('')
    expect(level.system_prompt).not.toBe('')
    expect(Object.keys(level.matrix).sort()).toEqual([...CLASSES].sort())
  }

  await page.goto('/admin/stufen')
  await expect(page.getByLabel('Räumliche Beziehungen – Prüfen')).toHaveValue('approve')
  await expect(page.getByLabel('Räumliche Beziehungen – Assistenz')).toHaveValue('off')
  await expect(page.getByLabel('Voreingestellt – Prüfen')).toBeChecked()
})

test(
  'E2.1: a local model is connected and its connection test is green',
  { tag: '@llm' },
  async ({ browser, page, request }) => {
    const url = process.env.E2E_LLM_URL
    const model = process.env.E2E_LLM_MODEL
    test.skip(!url || !model, 'E2E_LLM_URL and E2E_LLM_MODEL name a reachable local model')
    // Loading the model and two generation steps: minutes on a cold start.
    test.setTimeout(300_000)
    const name = `Abnahme ${model}`
    try {
      await page.goto('/admin/modelle')
      await page.getByRole('button', { name: 'Anbindung', exact: true }).click()
      const form = page.getByRole('form', { name: 'Neue Anbindung' })
      await form.getByLabel('Name').fill(name)
      await form.getByLabel('Adresse').fill(url!)
      await form.getByLabel('Modell').fill(model!)
      await form.getByLabel('Für Anwender freigegeben').check()
      await form.getByRole('button', { name: 'Speichern' }).click()

      const row = page.getByRole('row', { name: new RegExp(name) })
      await expect(row.getByText('lokal')).toBeVisible()
      await row.getByRole('button', { name: `Aktionen für ${name}` }).click()
      await page.getByRole('menuitem', { name: 'Verbindung testen' }).click()
      const result = page.getByRole('region', {
        name: `Verbindungstest „${name}"`,
      })
      await expect(result.getByText('Verbindungstest bestanden')).toBeVisible({
        timeout: 180_000,
      })

      // A user finds it in the workplace header, local, with the default level.
      await ensureAccount(request, browser, USER, 'user')
      const [context, userPage] = await signIn(browser, USER)
      const choice = userPage.getByRole('button', {
        name: 'Modellunterstützung wählen',
      })
      await expect(choice).toContainText(name)
      await expect(choice).toContainText('lokal')
      await expect(choice).toContainText('Stufe: Prüfen')
      await context.close()
    } finally {
      const all = (await (await request.get('/api/admin/llm/connections')).json()) as {
        id: number
        name: string
        enabled: boolean
      }[]
      for (const c of all.filter((c) => c.name === name)) {
        if (c.enabled)
          await request.patch(`/api/admin/llm/connections/${c.id}`, {
            data: { enabled: false },
          })
        await request.delete(`/api/admin/llm/connections/${c.id}`)
      }
    }
  },
)

test('E2.2: the model knows layers and attributes, not the data', async ({ browser, request }) => {
  await ensureAccount(request, browser, USER, 'user')
  const profile = await (
    await request.get(`/api/admin/llm/profile?account=${encodeURIComponent(USER)}`)
  ).json()
  const layers = profile.layers as {
    name: string
    attributes: { name: string }[]
  }[]
  const schulen = layers.find((l) => l.name === 'schulen')
  expect(schulen?.attributes.map((a) => a.name)).toContain('name')

  // Real values from the rows: none of them is in the profile.
  const result = await request.post('/api/query', {
    data: { source: 'schulen', select: ['name'], limit: 50 },
  })
  expect(result.ok(), await result.text()).toBe(true)
  const names = ((await result.json()).features as { properties: { name: string } }[]).map(
    (f) => f.properties.name,
  )
  expect(names.length).toBeGreaterThan(10)
  const text = JSON.stringify(profile)
  expect(names.filter((n) => text.includes(n))).toEqual([])
  for (const word of ['feature_count', 'bbox', 'dataset_version']) expect(text).not.toContain(word)
})
