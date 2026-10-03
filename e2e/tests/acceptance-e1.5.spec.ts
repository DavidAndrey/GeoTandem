import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import Ajv2020 from 'ajv/dist/2020.js'
import { readFileSync } from 'node:fs'

// Acceptance E1.5 (etappen.md): every action in the interface produces a valid
// query object as defined in E1.2 — the interface is its editor, not a second
// way around the machinery. Shown on the reference question (plan E1.5, D10):
// Primarschulen ≤ 500 m von einer Hauptstrasse, in Gemeinden mit Anteil
// unter 20 Jahren > 16 %.

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf-8'))
const reference = read('../fixtures/reference-question.json')
const validate = new Ajv2020({ strict: false }).compile(read('../../schema/query-object/v2.json'))
const AREAS = 'gemeinden_bevoelkerung'

/** The share of under-20s lives in a table; E1.3 imports it keyed onto the municipalities. */
async function ensureAreaLayer(request: APIRequestContext) {
  if ((await request.get(`/api/layers/${AREAS}`)).ok()) return
  const upload = await request.post('/api/admin/imports', {
    multipart: {
      file: {
        name: 'bevoelkerung.csv',
        mimeType: 'text/csv',
        buffer: readFileSync(
          new URL('../../backend/src/geotandem/sample/data/bevoelkerung.csv', import.meta.url),
        ),
      },
    },
  })
  const { import_id } = await upload.json()
  const run = await request.post(`/api/admin/imports/${import_id}/commit`, {
    data: {
      layer_name: AREAS,
      title: 'Bevölkerung je Gemeinde',
      geo: { mode: 'key', column: 'gem_nr', layer: 'gemeinden', attribute: 'gem_nr' },
      fields: [{ source_name: 'anteil_u20', label: 'Anteil unter 20 Jahren', unit: '%' }],
    },
  })
  expect((await run.json()).status).toBe('ok')
}

/** Every query the page sends to the engine, and every answer it gets. */
function watchQueries(page: Page) {
  const sent: unknown[] = []
  const failures: string[] = []
  page.on('request', (r) => {
    if (r.method() !== 'POST' || !/\/api\/query(\/count)?$/.test(r.url())) return
    const body = r.postDataJSON() as { queries?: unknown[] }
    sent.push(...(body.queries ?? [body]))
  })
  page.on('response', (r) => {
    if (/\/api\/query/.test(r.url()) && r.status() >= 400) failures.push(`${r.status()} ${r.url()}`)
  })
  return { sent, failures }
}

test('the reference question, answered by hand', async ({ page, request }) => {
  await ensureAreaLayer(request)
  const { sent, failures } = watchQueries(page)
  await page.goto('/')

  await page.getByRole('button', { name: 'Layer', exact: true }).click()
  const picker = page.getByRole('dialog', { name: 'Layer hinzufügen' })
  for (const name of [/^Schulen/, /^Strassen/, /^Bevölkerung je Gemeinde/])
    await picker.getByRole('checkbox', { name }).first().check()
  await picker.getByRole('button', { name: 'Hinzufügen' }).click()
  await expect(page.getByLabel('Trefferzahl')).toHaveText('120 von 120')

  await page.getByRole('button', { name: '+ Bedingung' }).click()
  const editor = page.getByRole('region', { name: 'Abfrage-Editor' })
  const kind = editor.getByRole('group', { name: 'Bedingung Attribut' })
  await kind.getByLabel('Feld').selectOption({ label: 'Schulstufe' })
  await kind.getByLabel('Operator').selectOption({ label: 'ist eins von' })
  await kind.getByLabel('Wert hinzufügen').fill('primar')
  await kind.getByLabel('Wert hinzufügen').press('Enter')

  const addSpatial = async () => {
    await editor.getByRole('button', { name: 'Bedingung', exact: true }).first().click()
    await page.getByRole('menuitem', { name: 'Raum' }).click()
    return editor.getByRole('group', { name: 'Bedingung Raum' }).last()
  }
  const road = await addSpatial()
  await road.getByLabel('Beziehung').selectOption({ label: '≤ Distanz zu' })
  await road.getByLabel('Distanz in Metern').fill('500')
  await road.getByLabel('Bezugslayer').selectOption({ label: 'Strassen' })
  await road.getByRole('button', { name: '+ Filter' }).click()
  await road.getByLabel('Feld').selectOption({ label: 'Strassenklasse' })
  await road.getByLabel('Wert').fill('haupt')

  const area = await addSpatial()
  await area.getByLabel('Beziehung').selectOption({ label: 'liegt in' })
  await area.getByLabel('Bezugslayer').selectOption({ label: 'Bevölkerung je Gemeinde' })
  await area.getByRole('button', { name: '+ Filter' }).click()
  await area.getByLabel('Feld').selectOption({ label: 'Anteil unter 20 Jahren' })
  await area.getByLabel('Operator').selectOption({ label: '>' })
  await area.getByLabel('Wert').fill('16')
  await editor.getByRole('button', { name: 'Übernehmen' }).click()

  // The engine's answer to the hand-written reference ...
  const expected = await request.post('/api/query/count', {
    data: { queries: [reference, { schema_version: '2', source: 'schulen' }] },
  })
  const [hits, total] = (await expected.json()).counts
  expect(hits).toBe(7)
  // ... is what the interface shows,
  await expect(page.getByLabel('Trefferzahl')).toHaveText(`${hits} von ${total}`)
  // ... because the interface built exactly that query object,
  await expect.poll(() => sent.some((q) => JSON.stringify(q) === JSON.stringify(reference))).toBe(true)

  // ... and nothing else it sent on the way was invalid or rejected.
  expect(sent.length).toBeGreaterThan(10)
  for (const query of sent) expect(validate(query), JSON.stringify(validate.errors)).toBe(true)
  expect(failures).toEqual([])
})
