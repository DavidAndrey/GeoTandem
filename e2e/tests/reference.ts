import { expect, type APIRequestContext, type Page } from '@playwright/test'
import Ajv2020 from 'ajv/dist/2020.js'
import { readFileSync } from 'node:fs'

// The reference question of E1 (plan E1.5, D10), built by hand in the
// interface: Primarschulen ≤ 500 m von einer Hauptstrasse, in Gemeinden mit
// Anteil unter 20 Jahren > 16 %. Shared by the acceptance tests of E1.5 and E1.6.

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf-8'))
export const reference = read('../fixtures/reference-question.json')
export const validate = new Ajv2020({ strict: false }).compile(
  read('../../schema/query-object/v2.json'),
)
const AREAS = 'gemeinden_bevoelkerung'

/** The share of under-20s lives in a table; E1.3 imports it keyed onto the municipalities. */
export async function ensureAreaLayer(request: APIRequestContext) {
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
  // Another worker may have imported it in the meantime: then that one counts.
  if ((await run.json()).status !== 'ok')
    expect((await request.get(`/api/layers/${AREAS}`)).ok()).toBe(true)
}

/** Every query the page sends to the engine, and every answer it gets. */
export function watchQueries(page: Page) {
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

/** Adds the layers and the three conditions, and applies them. */
export async function buildReferenceQuestion(page: Page) {
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
}
