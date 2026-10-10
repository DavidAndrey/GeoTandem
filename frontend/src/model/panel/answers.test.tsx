// Answers beside the query (plan WP68): an assumption opens its condition in
// B2 (M12.1), a clarification is answered without touching the analysis
// (M12.2), the other approach is offered but never sent (M13.1, D6), and a
// cannot-answer says what is missing (M13.2).
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { useAnalysis } from '../../analysis/store'
import type { ModelActionView } from '../../api/client'
import { activate } from '../../i18n/i18n'
import { messages as pseudo } from '../../locales/pseudo.po'
import { useMapView } from '../../map/view'
import { actionView, thinkingView, type CaseId } from '../../test/model-mocks'
import {
  ask,
  backend,
  done,
  fakeTimers,
  openPanel,
  promptFlow,
  resetStores,
  thinking,
  tick,
} from '../../test/prompt-panel'
import { strays } from '../../test/pseudo'
import { useModel } from '../store'

beforeEach(resetStores)
afterEach(done)

const posts = (calls: { key: string; body: unknown }[]) =>
  calls.filter((c) => c.key === 'POST /api/model/prompt').map((c) => c.body)

/** Sends a case's prompt; the first poll brings ``answer`` (default: the case's record). */
async function answered(id: CaseId, answer: ModelActionView = actionView(id), routes = {}) {
  const user = fakeTimers()
  const calls = backend({ ...promptFlow(thinkingView(id), answer), ...routes })
  await openPanel()
  await ask(user, answer.prompt)
  await thinking()
  await tick()
  const card = await screen.findByRole('article', { name: 'Antwort' })
  return { user, calls, card, answer }
}

describe('M12.1 assumption', () => {
  test('"ändern" opens the proposal in B2 at the condition it is about', async () => {
    const { user, card, answer } = await answered('reference')
    const change = within(card).getAllByRole('button', { name: /^Annahme ändern/ })
    // All three name a condition of the query.
    expect(change).toHaveLength(3)
    await user.click(change[2] as HTMLElement)

    const editor = await screen.findByRole('region', { name: 'Abfrage-Editor' })
    expect(within(editor).getByRole('note')).toHaveTextContent('Entwurf aus Vorschlag')
    // "hohe Steueranlage" is about the third condition (path [2]).
    const row = `m${answer.id}:q0.2`
    expect(useMapView.getState().activeRow).toBe(row)
    const active = editor.querySelector(`[data-row-id="${row}"]`) as HTMLElement
    expect(active.className).toContain('border-accent')
    expect(active).toContainElement(document.activeElement as HTMLElement)
    // Still a draft: the analysis is untouched.
    expect(useAnalysis.getState().tree.children).toEqual([])
  })

  test('without a condition there is nothing to open', async () => {
    const reference = actionView('reference')
    const answer = reference.answer?.kind === 'query' ? reference.answer : null
    const { card } = await answered(
      'reference',
      actionView('reference', {
        answer: answer && {
          ...answer,
          assumptions: answer.assumptions.map((a) => ({ text: a.text })),
        },
      }),
    )
    expect(within(card).getByText('Annahmen · 3')).toBeInTheDocument()
    expect(within(card).queryByRole('button', { name: /ändern/ })).toBeNull()
  })
})

describe('M12.2 clarification', () => {
  test('an option is sent at once as the answer; the analysis stays as it is', async () => {
    const { user, calls, card, answer } = await answered('clarification')
    const before = useAnalysis.getState().tree
    expect(within(card).getByRole('status')).toHaveTextContent('Rückfrage')
    expect(card).toHaveTextContent('Wie nahe ist „in der Nähe“?')
    const options = within(card).getByRole('group', { name: 'Antworten' })
    expect(
      within(options)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['250 m', '500 m', '1 km', 'anderes …'])

    await user.click(within(options).getByRole('button', { name: '500 m' }))
    await waitFor(() => expect(posts(calls)).toHaveLength(2))
    // Follows the question (P6), with the analysis as it is: schools, no condition.
    expect(posts(calls)[1]).toMatchObject({
      text: '500 m',
      approach: 'direct',
      parent_action_id: answer.id,
      analysis: { source: 'schulen' },
    })
    expect(posts(calls)[1]).not.toHaveProperty('analysis.where')
    expect(useAnalysis.getState().tree).toBe(before)
    expect(useAnalysis.getState().draft).toBeNull()
  })

  test('"anderes …" leaves the free answer to the field, which answers the question', async () => {
    const { user, calls, card, answer } = await answered('clarification')
    await user.click(within(card).getByRole('button', { name: 'anderes …' }))
    const field = screen.getByRole('textbox', { name: 'Prompt' })
    expect(field).toHaveFocus()
    expect(field).toHaveAccessibleDescription('Ihre Eingabe beantwortet die Rückfrage.')
    expect(posts(calls)).toHaveLength(1)
    await user.paste('höchstens 300 m')
    await user.keyboard('{Control>}{Enter}{/Control}')
    expect(posts(calls)[1]).toMatchObject({
      text: 'höchstens 300 m',
      parent_action_id: answer.id,
    })
  })
})

describe('M13 approach and cannot-answer', () => {
  test('M13.1: the chain is offered disabled until E2.5, with what it would do', async () => {
    const { card } = await answered('other_approach')
    expect(within(card).getByRole('status')).toHaveTextContent('Meldung· Arbeitsweise passt nicht')
    expect(card).toHaveTextContent('Puffer und Zählung je Gemeinde nacheinander')
    const offer = within(card).getByRole('button', { name: 'Mit Werkzeugkette versuchen' })
    expect(offer).toBeDisabled()
    expect(offer).toHaveAccessibleDescription(
      'Stellt den Schalter auf Werkzeugkette und setzt denselben Prompt ins Feld. Gesendet wird erst mit Senden.',
    )
    expect(within(card).getByText('ab E2.5')).toBeInTheDocument()
  })

  test('M13.1: the offer switches the toggle and fills the field, and never sends (D6)', async () => {
    // The other way round, which E2.3 can already do: a chain request, offered as direct.
    const record = actionView('other_approach')
    const said = record.answer?.kind === 'cannot_answer' ? record.answer : null
    const offered = actionView('other_approach', {
      approach: 'chain',
      answer: said && { ...said, other_approach: 'direct' },
    })
    const { user, calls, card } = await answered('other_approach', offered)
    useModel.getState().setApproach('chain')
    await user.click(within(card).getByRole('button', { name: 'Als Direktabfrage versuchen' }))

    const field = screen.getByRole('textbox', { name: 'Prompt' })
    expect(field).toHaveValue(offered.prompt)
    expect(field).toHaveFocus()
    expect(screen.getByRole('radio', { name: 'Direktabfrage' })).toBeChecked()
    await tick(3000)
    expect(posts(calls)).toHaveLength(1)
  })

  test('M13.2: cannot answer lists what is missing and offers no button', async () => {
    const { card } = await answered('cannot_answer')
    expect(within(card).getByRole('status')).toHaveTextContent('Meldung· nicht beantwortbar')
    expect(card).toHaveTextContent('Für Lärm gibt es keine Angaben')
    const missing = within(card).getByRole('region', { name: 'Es fehlt' })
    expect(
      within(missing)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Layer mit Lärmwerten', 'Attribut Lärm an Schulen'])
    expect(within(card).queryAllByRole('button')).toEqual([])
    expect(useAnalysis.getState().tree.children).toEqual([])
  })
})

test('in pseudo, the messages show no text outside the catalog', async () => {
  activate('pseudo', pseudo)
  try {
    for (const id of ['clarification', 'other_approach', 'cannot_answer'] as const) {
      const record = actionView(id)
      const user = fakeTimers()
      backend(promptFlow(thinkingView(id), record))
      await openPanel()
      await ask(user, record.prompt)
      await thinking()
      await tick()
      const said = record.answer
      const data = [
        'Schulen',
        'Strassen',
        'Gemeinden · Steuern',
        'Lokales Modell',
        'Prüfen',
        record.prompt,
        ...(said?.kind === 'clarification' ? [said.question, ...said.options] : []),
        ...(said?.kind === 'cannot_answer' ? [said.explanation, ...said.missing] : []),
      ]
      await waitFor(() => expect(document.querySelector('[data-line="message"]')).not.toBeNull())
      expect(strays(data)).toEqual([])
      done()
      resetStores()
    }
  } finally {
    cleanup()
    activate('de')
  }
})
