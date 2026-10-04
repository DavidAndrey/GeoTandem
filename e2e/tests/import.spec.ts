import { expect, test, type Page } from './test'
import { join } from 'node:path'
import { FILES_DIR } from '../global-setup'

// Acceptance E1.3 (etappen.md): all three import paths end as a managed layer
// with spatial index and metadata, and every attempt is in the log.

// The catalog test checks the layers the import tests created.
test.describe.configure({ mode: 'serial' })

const run = `imp${Date.now().toString(36)}`

async function startImport(page: Page, file: string, title: string) {
  await page.goto('/admin/daten/import')
  await page.getByLabel('Importdatei').setInputFiles(join(FILES_DIR, file))
  await expect(page.getByText(file, { exact: true })).toBeVisible()
  await page.getByLabel('Bezeichnung').fill(title)
  await page.getByLabel('Technischer Name').fill(`e2e_${run}_${file.split('.')[0]}`)
}

async function next(page: Page) {
  await page.getByRole('button', { name: 'Weiter' }).click()
}

async function finish(page: Page, title: string) {
  await page.getByRole('button', { name: 'Übernehmen' }).click()
  await expect(page.getByText('Import abgeschlossen')).toBeVisible()
  await page.getByRole('link', { name: 'Layer öffnen' }).click()
  await expect(page.getByRole('heading', { name: title })).toBeVisible()
}

test('vector file: GeoPackage, second layer in the file', async ({ page }) => {
  const title = `Gewässer ${run}`
  await startImport(page, 'netz.gpkg', title)
  await page.getByRole('combobox').first().selectOption('gewaesser')
  await expect(page.getByText(/66 Datensätze/)).toBeVisible()
  await page.getByLabel('Bezeichnung').fill(title)
  await next(page)
  await expect(page.getByLabel('EPSG-Code')).toHaveValue('2056')
  await next(page)
  await page.getByLabel('Bezeichnung typ').fill('Gewässertyp')
  await next(page)
  await finish(page, title)
  await expect(page.getByText('Linie · 66 Objekte')).toBeVisible()
  await page.getByRole('tab', { name: 'Felder' }).click()
  await expect(page.getByLabel('Bezeichnung typ')).toHaveValue('Gewässertyp')
})

test('table with X/Y columns: CSV with semicolons and decimal commas', async ({ page }) => {
  const title = `Messstellen ${run}`
  await startImport(page, 'messstellen.csv', title)
  await expect(page.getByText(/Trennzeichen „;"/)).toBeVisible()
  await next(page)
  await expect(page.getByRole('radio', { name: 'Koordinatenspalten (X / Y)' })).toBeChecked()
  await next(page)
  await page.getByLabel('Einheit Höhe ü. M.').fill('m ü. M.')
  await next(page)
  await finish(page, title)
  await expect(page.getByText('Punkt · 20 Objekte')).toBeVisible()
})

test('table with an area key: Excel joined to the municipalities', async ({ page }) => {
  const title = `Kennzahlen ${run}`
  await startImport(page, 'kennzahlen.xlsx', title)
  await next(page)
  await expect(page.getByRole('radio', { name: 'Schlüssel auf vorhandenen Layer' })).toBeChecked()
  await expect(page.getByText('74 / 76 zugeordnet')).toBeVisible()
  await next(page)
  await next(page)
  await finish(page, title)
  await expect(page.getByText('Fläche · 74 Objekte')).toBeVisible()
  await page.getByRole('tab', { name: 'Vorschau' }).click()
  await expect(page.getByText('"references": "gemeinden.gem_nr"')).toBeVisible()
})

test('the catalog and the log show the imports', async ({ page }) => {
  await page.goto('/admin/daten')
  await page.getByLabel('Layer suchen').fill(run)
  await expect(page.getByRole('row')).toHaveCount(4) // header + 3 imports
  await page.goto('/admin/protokoll')
  await expect(page.getByRole('cell', { name: 'kennzahlen.xlsx' }).first()).toBeVisible()
})

test('a file without CRS is stopped and logged as failed', async ({ page }) => {
  await startImport(page, 'gemeinden_ohne_prj.zip', `Ohne CRS ${run}`)
  await next(page)
  await expect(page.getByText('Das Koordinatensystem ist nicht erkannt; bitte wählen.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Weiter' })).toBeDisabled()
  await page.getByRole('button', { name: 'Abbrechen' }).click()
  await expect(page).toHaveURL(/\/admin\/daten$/)
  await page.goto('/admin/protokoll?status=aborted')
  await expect(page.getByRole('cell', { name: 'gemeinden_ohne_prj.zip' }).first()).toBeVisible()
})
