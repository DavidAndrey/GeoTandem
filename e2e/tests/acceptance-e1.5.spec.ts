import { expect, test } from '@playwright/test'
import { buildReferenceQuestion, ensureAreaLayer, reference, validate, watchQueries } from './reference'

// Acceptance E1.5 (etappen.md): every action in the interface produces a valid
// query object as defined in E1.2 — the interface is its editor, not a second
// way around the machinery. Shown on the reference question (plan E1.5, D10):
// Primarschulen ≤ 500 m von einer Kantonsstrasse Kategorie B, in Gemeinden mit
// Steueranlage > 1.6.

test('the reference question, answered by hand', async ({ page, request }) => {
  await ensureAreaLayer(request)
  const { sent, failures } = watchQueries(page)
  await buildReferenceQuestion(page)

  // The engine's answer to the hand-written reference ...
  const expected = await request.post('/api/query/count', {
    data: { queries: [reference, { schema_version: '2', source: 'schulen' }] },
  })
  const [hits, total] = (await expected.json()).counts
  expect(hits).toBe(10)
  // ... is what the interface shows,
  await expect(page.getByLabel('Trefferzahl')).toHaveText(`${hits} von ${total}`)
  // ... because the interface built exactly that query object,
  await expect.poll(() => sent.some((q) => JSON.stringify(q) === JSON.stringify(reference))).toBe(true)

  // ... and nothing else it sent on the way was invalid or rejected.
  expect(sent.length).toBeGreaterThan(10)
  for (const query of sent) expect(validate(query), JSON.stringify(validate.errors)).toBe(true)
  expect(failures).toEqual([])
})
