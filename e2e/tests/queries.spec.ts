import { expect, test, type Page } from '@playwright/test'
import { ensureAccount, signIn } from './accounts'

// Saved and shared queries (plan E1.7b, design B1, C6): one account saves a
// query and shares it; another opens it, changes it and keeps an own copy;
// deleting the original says how many sessions use it, and those sessions
// still reopen identical — they keep their own conditions.

test.describe.configure({ mode: 'serial' })

// Fresh accounts per run: the gate runs twice on the same data.
const run = Date.now().toString(36)
const A = `abfrage-a-${run}`
const B = `abfrage-b-${run}`
// Shared queries are seen by every account: the name is per run, too.
const NAME = `Primarschulen ${run} (geteilt)`

async function primarySchools(page: Page) {
  await page.getByRole('button', { name: 'Layer', exact: true }).click()
  const picker = page.getByRole('dialog', { name: 'Layer hinzufügen' })
  await picker.getByRole('checkbox', { name: /^Schulen/ }).check()
  await picker.getByRole('button', { name: 'Hinzufügen' }).click()
  await page.getByRole('button', { name: '+ Bedingung' }).click()
  const editor = page.getByRole('region', { name: 'Abfrage-Editor' })
  const row = editor.getByRole('group', { name: 'Bedingung Attribut' })
  await row.getByLabel('Feld').selectOption({ label: 'Höchste Schulstufe' })
  await row.getByLabel('Operator').selectOption({ label: 'ist eins von' })
  await row.getByLabel('Wert hinzufügen').fill('primar')
  await row.getByLabel('Wert hinzufügen').press('Enter')
  await editor.getByRole('button', { name: 'Übernehmen' }).click()
}

test('a shared query is read by others, copied when changed, and deleted with notice', async ({
  browser,
  request,
}) => {
  await ensureAccount(request, browser, A, 'admin')
  await ensureAccount(request, browser, B, 'user')

  // A: builds and saves the query, shared, and a session that uses it.
  const [contextA, a] = await signIn(browser, A)
  await primarySchools(a)
  const hits = await a.getByLabel('Trefferzahl').textContent()
  const queries = a.getByRole('button', { name: 'Gespeicherte Abfragen' })
  await queries.click()
  await a.getByRole('menuitem', { name: 'Speichern', exact: true }).click()
  const save = a.getByRole('dialog', { name: 'Abfrage speichern' })
  await save.getByLabel('Name').fill(NAME)
  await save.getByRole('checkbox', { name: /Geteilt/ }).check()
  await save.getByRole('button', { name: 'Speichern' }).click()
  await expect(queries).toHaveText(NAME)
  await a.keyboard.press('Control+s')
  const session = a.getByRole('dialog', { name: 'Sitzung speichern' })
  await session.getByLabel('Name').fill('Mit geteilter Abfrage')
  await session.getByRole('button', { name: 'Speichern' }).click()
  await expect(a.getByRole('button', { name: 'Sitzungsmenü' })).toHaveText('Mit geteilter Abfrage')

  // B: sees it as shared by A, opens it in an empty workplace, same hits.
  const [contextB, b] = await signIn(browser, B)
  const theirs = b.getByRole('button', { name: 'Gespeicherte Abfragen' })
  await theirs.click()
  const item = b.getByRole('menuitem', { name: new RegExp(NAME.replace(/[()]/g, '\\$&')) })
  await expect(item).toContainText(`geteilt von ${A}`)
  await item.click()
  await expect(theirs).toHaveText(NAME)
  await expect(b.getByLabel('Trefferzahl')).toHaveText(hits ?? '')

  // B changes it; saving makes an own copy, the shared one stays as it was.
  await b.getByRole('button', { name: 'Ausschnitt' }).click()
  await expect(theirs).toContainText('geändert')
  await theirs.click()
  await b.getByRole('menuitem', { name: /^Speichern\s*als Kopie/ }).click()
  const copy = b.getByRole('dialog', { name: 'Abfrage speichern' })
  await expect(copy).toContainText('gehört jemand anderem')
  await copy.getByLabel('Name').fill('Primarschulen im Ausschnitt')
  await copy.getByRole('button', { name: 'Speichern' }).click()
  await expect(theirs).toHaveText('Primarschulen im Ausschnitt')
  const listed = (await (await b.request.get('/api/queries')).json()) as {
    name: string
    mine: boolean
    conditions: { restriction: boolean }
  }[]
  // Other runs' shared queries may be listed too; this run's are these.
  const ours = listed.filter((q) => q.mine || q.name === NAME)
  expect(ours.map((q) => [q.name, q.mine, q.conditions.restriction]).sort()).toEqual(
    [
      [NAME, false, false],
      ['Primarschulen im Ausschnitt', true, true],
    ].sort(),
  )

  // A deletes the shared query: told that a session uses it.
  await a.getByRole('button', { name: 'Gespeicherte Abfragen' }).click()
  await a.getByRole('menuitem', { name: 'Verwalten …' }).click()
  const table = a.getByRole('table', { name: 'Gespeicherte Abfragen' })
  await table.getByRole('button', { name: `Aktionen für ${NAME}` }).click()
  await a.getByRole('menuitem', { name: 'Löschen' }).click()
  const ask = a.getByRole('alertdialog')
  await expect(ask).toContainText('in 1 Sitzung verwendet')
  await ask.getByRole('button', { name: 'Löschen' }).click()
  await expect(table.getByText(NAME)).toBeHidden()

  // The session keeps its conditions: it still reopens identical.
  const sessions = (await (await a.request.get('/api/sessions')).json()) as { id: string }[]
  const check = await (await a.request.post(`/api/sessions/${sessions[0]?.id}/check`)).json()
  expect(check.identical).toBe(true)
  // And B no longer sees it.
  const after = (await (await b.request.get('/api/queries')).json()) as { name: string }[]
  expect(after.filter((q) => q.name === NAME)).toEqual([])
  await contextA.close()
  await contextB.close()
})
