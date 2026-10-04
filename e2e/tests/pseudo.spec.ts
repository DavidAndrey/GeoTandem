import { expect, test, type Page } from './test'
import { ensureAccount, signIn } from './accounts'
import { buildReferenceQuestion, ensureAreaLayer } from './reference'

// Plan E1.9, L8: the shipped interface in the pseudo-locale. Every text and
// label it shows is either bracketed ⟦…⟧ (it went through the catalog) or
// data from the back end. The unit tests render each view with a fake back
// end; this one sees the real data, the real session and the pseudo catalog
// loading under the real Content-Security-Policy.

test.describe.configure({ mode: 'serial' })

const SESSION = 'Pseudo E1.9'

/** Text the back end owns: names, titles, labels and values of the catalog. */
async function dataOf(page: Page): Promise<string[]> {
  const layers = (await (await page.request.get('/api/layers')).json()) as {
    name: string
    title: string
    attributes: { name: string; label: string; unit: string | null }[]
  }[]
  // Names that stay names: the product, stages, protocols.
  const words = new Set([SESSION, 'pseudo', 'GeoTandem', 'MCP', 'E2', 'E3', 'E4', 'EPSG'])
  words.add('primar').add('kantonsstrasse_b')
  for (const layer of layers) {
    words.add(layer.name).add(layer.title)
    for (const a of layer.attributes) {
      words.add(a.name).add(a.label)
      if (a.unit) words.add(a.unit)
    }
  }
  return [...words].filter(Boolean)
}

/** Every visible text and label outside ⟦…⟧ and outside ``data`` (see src/test/pseudo.ts). */
function strays(page: Page, data: string[]): Promise<string[]> {
  return page.evaluate((data) => {
    const unmarked = (text: string) => {
      let rest = text
      for (const value of [...data].sort((a, b) => b.length - a.length))
        rest = rest.split(value).join('')
      for (let previous = ''; previous !== rest; ) {
        previous = rest
        rest = rest.replace(/⟦[^⟦⟧]*⟧/g, '')
      }
      return rest
        .split(/[\s\p{P}]+/u)
        .filter((word) => /[A-Za-z]/.test(word))
        .join(' ')
        .replace(/[^\p{L}]/gu, '')
    }
    const skip = 'script, style, .leaflet-control-container, td'
    const unit = /^\s*(m|km|m²|ha|km²|%)\s*$/
    const found = new Set<string>()
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    // An element's text without what lies in skipped parts (Leaflet's credit).
    const textOf = (element: Element) => {
      let text = ''
      const inner = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      for (let n = inner.nextNode(); n; n = inner.nextNode())
        if (!n.parentElement?.closest(skip)) text += n.textContent ?? ''
      return text
    }
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const element = node.parentElement
      const own = node.textContent ?? ''
      if (!element || element.closest(skip) || unit.test(own) || !/\p{L}/u.test(own)) continue
      // React may split one message into several text nodes; judge the element's text.
      const text = textOf(element)
      if (unmarked(text)) found.add(text.trim())
    }
    for (const element of Array.from(
      document.body.querySelectorAll('[aria-label], [title], [placeholder]'),
    )) {
      if (element.closest(skip)) continue
      for (const name of ['aria-label', 'title', 'placeholder']) {
        const value = element.getAttribute(name)
        if (value && unmarked(value)) found.add(`${name}="${value}"`)
      }
    }
    return [...found]
  }, data)
}

test('the reference question in the pseudo-locale', async ({ browser, request }) => {
  await ensureAreaLayer(request)
  await ensureAccount(request, browser, 'pseudo')
  const [context, page] = await signIn(browser, 'pseudo')
  await expect(page.getByRole('button', { name: 'Sitzungsmenü' })).toBeVisible()
  const sessions = (await (await page.request.get('/api/sessions')).json()) as { name: string }[]
  if (!sessions.some((s) => s.name === SESSION)) {
    // Built and saved in German, the labels the helpers know.
    await buildReferenceQuestion(page)
    await expect(page.getByLabel('Trefferzahl')).toHaveText('10 von 137')
    await page.keyboard.press('Control+s')
    const dialog = page.getByRole('dialog', { name: 'Sitzung speichern' })
    await dialog.getByLabel('Name').fill(SESSION)
    await dialog.getByRole('button', { name: 'Speichern' }).click()
    await expect(page.getByRole('status', { name: 'Speicherstand' })).toHaveText(/^gespeichert/)
  }
  const data = await dataOf(page)

  // Reopened in pseudo: it lands in the saved session and checks it (design C4).
  await page.goto('/?lang=pseudo')
  await expect(page.locator('html')).toHaveAttribute('lang', 'de')
  await expect(page.getByText(SESSION).first()).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: /⟦/ }).first()).toBeVisible()
  await expect.poll(() => strays(page, data)).toEqual([])

  // The administration, on the real catalog.
  await page.goto('/admin/daten')
  await expect(page.getByRole('table')).toBeVisible()
  await expect.poll(() => strays(page, data)).toEqual([])
  await page.goto('/admin/protokoll')
  await expect(page.getByRole('table')).toBeVisible()
  await expect.poll(() => strays(page, data)).toEqual([])

  // Back to German for this tab.
  await page.goto('/?lang=de')
  await expect(page.getByRole('button', { name: 'Sitzungsmenü' })).toBeVisible()
  await context.close()
})
