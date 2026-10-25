// A case in a run (design V7, plan WP93): the repeats, a wrong answer opened
// with the stage-1 diff in words, right but worded otherwise, refused and
// unreadable, a behaviour case; the workplace opening of answer and reference.
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { App } from '../../App'
import { useAnalysis } from '../../analysis/store'
import { newAttributeRow } from '../../analysis/tree'
import { answerViews, behaviourAnswer, refusedAnswers, rightOtherwise } from '../../test/eval-mocks'
import { renderAt } from '../../test/render'
import { runBackend, RUNS_URL } from '../../test/run-api'

beforeEach(() => {
  vi.stubGlobal('scrollTo', () => undefined)
  useAnalysis.getState().reset()
})
afterEach(() => vi.unstubAllGlobals())

const ANSWERS = `GET ${RUNS_URL}/13/answers`

test('V7.1: question and reference left, the ten repeats right', async () => {
  const calls = runBackend({ [ANSWERS]: answerViews() })
  renderAt('/admin/bewertung/lauf/13/fall/n13-bahnhof-bern?punkt=3', <App />)
  expect(
    await screen.findByRole('heading', { name: 'Lauf #13 › n13-bahnhof-bern › gpt-6-luna P9' }),
  ).toBeInTheDocument()
  expect(screen.getByText('Schulen im Umkreis von 1 km um den Bahnhof Bern')).toBeInTheDocument()
  // The reference as the readable tree, its hits from the answers.
  expect(screen.getByRole('group', { name: 'Bedingungen' })).toBeInTheDocument()
  expect(await screen.findByText(/23 Treffer · Datenstand Beispieldaten/)).toBeInTheDocument()
  const answers = await screen.findByRole('region', { name: 'Antworten' })
  expect(
    within(answers).getByText('Antworten · 4 richtig · 6 falsch, alle still'),
  ).toBeInTheDocument()
  const names = within(answers)
    .getAllByRole('button', { name: /^Antwort / })
    .map((b) => b.textContent)
  expect(names).toEqual(['1.1', '1.2', '1.3', '1.4', '1.5', '2.1', '2.2', '2.3', '2.4', '2.5'])
  expect(within(answers).getAllByText('falsch · still')).toHaveLength(6)
  expect(within(answers).getAllByText('richtig')).toHaveLength(4)
  expect(calls.find((c) => c.key === ANSWERS)).toBeDefined()
})

test('V7.2: a wrong answer opened shows the difference in words, both sets and the objects', async () => {
  runBackend({ [ANSWERS]: answerViews() })
  const user = userEvent.setup()
  renderAt('/admin/bewertung/lauf/13/fall/n13-bahnhof-bern?punkt=3', <App />)
  const toggle = await screen.findByRole('button', { name: 'Antwort 1.2' })
  await user.click(toggle)
  expect(toggle).toHaveAttribute('aria-expanded', 'true')
  const detail = document.getElementById(toggle.getAttribute('aria-controls') ?? '')
  if (!detail) throw new Error('no detail')
  expect(within(detail).getByText('Antwort 1.2 · Unterschied zur Referenz')).toBeInTheDocument()
  const changes = within(detail).getByRole('list', { name: 'Änderungen' })
  expect(changes).toHaveTextContent(/− entfällt: fehlende Bedingung: .*Haltestellen/)
  expect(detail).toHaveTextContent(
    'Referenz 23 · Antwort 236 · nur in Antwort 213 · nur in Referenz 0',
  )
  // Twelve ids named, the rest counted against the exact total (213, of which 200 were sent).
  expect(
    within(detail).getByText(
      /^Nur in Antwort: Objekt 24, Objekt 25, .* Objekt 35 und 201 weitere$/,
    ),
  ).toBeInTheDocument()
  expect(detail).toHaveTextContent('still falsch')
  expect(within(detail).getByRole('button', { name: 'Antwort im Arbeitsplatz' })).toBeEnabled()
  expect(within(detail).getByRole('button', { name: 'Referenz im Arbeitsplatz' })).toBeEnabled()
  await user.click(within(detail).getByText('Technisch (Antwort JSON · Rohtext)'))
  expect(detail).toHaveTextContent('"source": "schulen"')
})

test('V7.2: opening an answer in the workplace asks before unsaved conditions are lost', async () => {
  runBackend({ [ANSWERS]: answerViews() })
  const s = useAnalysis.getState()
  s.addLayer('schulen')
  s.edit()
  s.addNode('root', { ...newAttributeRow('typ'), value: 'primar' })
  s.apply()
  const user = userEvent.setup()
  renderAt('/admin/bewertung/lauf/13/fall/n13-bahnhof-bern?punkt=3', <App />)
  await user.click(await screen.findByRole('button', { name: 'Antwort 1.2' }))
  await user.click(screen.getByRole('button', { name: 'Antwort im Arbeitsplatz' }))
  const dialog = await screen.findByRole('alertdialog', {
    name: 'Abfrage im Arbeitsplatz ersetzen?',
  })
  expect(dialog).toHaveTextContent('durch die Abfrage dieser Antwort ersetzt')
  await user.click(within(dialog).getByRole('button', { name: 'Abbrechen' }))
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
})

test('V7.3: right, but worded otherwise: the diff stays visible, the verdict is right', async () => {
  runBackend({ [ANSWERS]: [rightOtherwise()] })
  const user = userEvent.setup()
  renderAt('/admin/bewertung/lauf/13/fall/doc1-primar-koeniz?punkt=0', <App />)
  await user.click(await screen.findByRole('button', { name: 'Antwort 1.1' }))
  expect(screen.getByText('Antwort 1.1 · Unterschied zur Lesart A')).toBeInTheDocument()
  expect(screen.getByRole('list', { name: 'Änderungen' })).toHaveTextContent('fehlende Bedingung:')
  expect(
    screen.getByText(
      /Stufe 1 erklärt den Unterschied, sie urteilt nicht: gleiche Ergebnismenge = richtig\./,
    ),
  ).toBeInTheDocument()
  expect(screen.getByText('richtig')).toHaveAttribute('data-verdict', 'pass')
  // Two readings: both trees on the left.
  expect(screen.getAllByRole('group', { name: /^Lesart [AB]$/ })).toHaveLength(2)
})

test('V7.4: refused and unreadable: the code in words, the raw text under "Technisch"', async () => {
  runBackend({ [ANSWERS]: refusedAnswers() })
  const user = userEvent.setup()
  renderAt('/admin/bewertung/lauf/13/fall/n13-bahnhof-bern?punkt=1', <App />)
  // Sorted by block and seed: 1.1 the unreadable one, 2.1 the refused one.
  await user.click(await screen.findByRole('button', { name: 'Antwort 2.1' }))
  const refusal = screen.getAllByRole('alert').find((a) => a.textContent?.includes('abgewiesen'))
  expect(refusal).toHaveTextContent(/bahnhof_name/)
  await user.click(screen.getByRole('button', { name: 'Antwort 1.1' }))
  expect(screen.getByText('Antwort nicht lesbar')).toBeInTheDocument()
  await user.click(screen.getByText('Technisch (Antwort JSON · Rohtext)'))
  expect(screen.getByText(/"op": "related"$/)).toBeInTheDocument()
  expect(screen.getByText('code: model_unreadable')).toBeInTheDocument()
})

test('V7.5: a behaviour case, expected against given', async () => {
  runBackend({ [ANSWERS]: [behaviourAnswer()] })
  const user = userEvent.setup()
  renderAt('/admin/bewertung/lauf/13/fall/n15-je-gemeinde?punkt=2', <App />)
  expect(await screen.findByText('Verhaltensfall')).toBeInTheDocument()
  await user.click(await screen.findByRole('button', { name: 'Antwort 1.1' }))
  const verdict = screen
    .getAllByText('andere Antwortart')
    .find((e) => e.hasAttribute('data-verdict'))
  expect(verdict).toBeDefined()
  const given = screen.getAllByText('Gegeben').at(-1)?.nextElementSibling
  expect(given).toHaveTextContent('Abfrage · Alle 412 Schulen, ohne Zählung.')
  const expected = screen.getAllByText('Erwartet').at(-1)?.nextElementSibling
  expect(expected).toHaveTextContent('Nicht beantwortbar')
})

test('V7: the neighbours of a cell, by case and by point', async () => {
  runBackend({ [ANSWERS]: answerViews() })
  renderAt('/admin/bewertung/lauf/13/fall/n13-bahnhof-bern?punkt=3', <App />)
  const nav = await screen.findByRole('navigation', { name: 'Weitere Zellen' })
  expect(within(nav).getByRole('link', { name: 'Voriger Messpunkt' })).toHaveAttribute(
    'href',
    '/admin/bewertung/lauf/13/fall/n13-bahnhof-bern?punkt=2',
  )
  expect(within(nav).queryByRole('link', { name: 'Nächster Messpunkt' })).toBeNull()
  expect(within(nav).getByRole('link', { name: 'Nächster Fall' })).toBeInTheDocument()
})

test("V7: ‹ › follow the matrix's order within the part it was opened from", async () => {
  runBackend({ [ANSWERS]: answerViews() })
  renderAt('/admin/bewertung/lauf/13/fall/doc1-primar-koeniz?punkt=0&teil=tuning', <App />)
  const nav = await screen.findByRole('navigation', { name: 'Weitere Zellen' })
  // The first row of the first group (räumlich): none before; the next spatial case after.
  expect(within(nav).queryByRole('link', { name: 'Voriger Fall' })).toBeNull()
  expect(within(nav).getByRole('link', { name: 'Nächster Fall' })).toHaveAttribute(
    'href',
    '/admin/bewertung/lauf/13/fall/doc3-weit-von-bahn?punkt=0&teil=tuning',
  )
})

test('V7.2: an answer the workplace cannot show says why its button is disabled', async () => {
  const [first] = answerViews()
  runBackend({
    [ANSWERS]: [
      { ...first, answer: { ...first.answer, query: { source: 'kitas' } } } as typeof first,
    ],
  })
  const user = userEvent.setup()
  renderAt('/admin/bewertung/lauf/13/fall/n13-bahnhof-bern?punkt=3', <App />)
  await user.click(await screen.findByRole('button', { name: 'Antwort 1.1' }))
  const button = screen.getByRole('button', { name: 'Antwort im Arbeitsplatz' })
  expect(button).toBeDisabled()
  expect(button).toHaveAttribute('title', expect.stringMatching(/nicht darstellen/))
  expect(screen.getAllByText(/lässt sich im Arbeitsplatz nicht darstellen/).length).toBeGreaterThan(
    0,
  )
})
