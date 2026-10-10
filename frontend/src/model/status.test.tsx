// The status language (design E2 "Statussprache", plan WP66): every label in
// German and pseudo, its line style, the mapping from the action record, and
// what a screen reader gets.
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import type { ActionStatus, ModelActionView } from '../api/client'
import { actionView, thinkingView } from '../test/model-mocks'
import { inPseudo, strays, unmarked } from '../test/pseudo'
import { ENFORCEMENT } from './enforcement'
import { StatusLabel } from './status'
import {
  lineStyle,
  STATUS_KEYS,
  statusKey,
  statusText,
  type LineStyle,
  type StatusKey,
} from './statusKey'

afterEach(cleanup)

// The design's words (README "Verhalten und Zustand") and its line styles.
const DESIGN: Record<StatusKey, [string, LineStyle]> = {
  thinking: ['Modell arbeitet …', 'dashed'],
  awaiting: ['wartet auf Freigabe', 'dashed'],
  proposal: ['Vorschlag', 'dashed'],
  approved: ['freigegeben', 'dashed'],
  running: ['läuft', 'dashed'],
  done: ['fertig', 'dashed'],
  limited: ['angehalten · Begrenzung', 'dashed'],
  applied: ['angewendet', 'applied'],
  auto: ['automatisch angewendet', 'applied'],
  by_hand: ['von Hand übernommen', 'applied'],
  rejected: ['abgelehnt', 'void'],
  superseded: ['übergangen', 'void'],
  undone: ['zurückgenommen', 'void'],
  refused: ['abgewiesen', 'void'],
  stale: ['veraltet', 'void'],
  aborted: ['abgebrochen', 'void'],
  clarification: ['Rückfrage', 'message'],
  message: ['Meldung', 'message'],
  error: ['Fehler', 'message'],
}

describe('labels', () => {
  test('the design names every state', () => {
    expect(new Set(STATUS_KEYS)).toEqual(new Set(Object.keys(DESIGN)))
  })

  test.each(STATUS_KEYS)('%s in German, in its line style', (key) => {
    const [text, style] = DESIGN[key]
    render(<StatusLabel status={key} />)
    const label = screen.getByText(text).parentElement as HTMLElement
    expect(label).toHaveAttribute('data-line', style)
    expect(lineStyle(key)).toBe(style)
    // No colour of its own: the line and the text carry the status.
    if (style === 'void') expect(label.className).toMatch(/line-through/)
    else expect(label.className).not.toMatch(/line-through/)
    expect(label.className.includes('border-dashed')).toBe(style === 'dashed')
  })

  test.each(STATUS_KEYS)('%s in pseudo goes through the catalog', (key) => {
    expect(unmarked(inPseudo(() => statusText(key)))).toBe('')
    inPseudo(() => render(<StatusLabel status={key} detail="14:06" live />))
    expect(strays(['14:06'])).toEqual([])
  })

  test('every state reads differently: no status by colour alone', () => {
    const texts = STATUS_KEYS.map(statusText)
    expect(new Set(texts).size).toBe(texts.length)
  })
})

describe('accessibility', () => {
  test('a changing status is a live region named by its text', () => {
    const { rerender } = render(<StatusLabel status="thinking" live />)
    expect(screen.getByRole('status')).toHaveTextContent('Modell arbeitet …')
    rerender(<StatusLabel status="applied" detail="14:06" live />)
    expect(screen.getByRole('status')).toHaveTextContent('angewendet14:06')
  })

  test.each([
    ['error', 'Fehler'],
    ['refused', 'abgewiesen'],
  ] as const)('a live %s is an alert (design: Fehler und Abweisung)', (key, text) => {
    render(<StatusLabel status={key} live />)
    expect(screen.getByRole('alert')).toHaveTextContent(text)
    expect(screen.queryByRole('status')).toBeNull()
  })

  test('a label in a list is no live region; icons are hidden from screen readers', () => {
    const { container } = render(
      <>
        <StatusLabel status="applied" />
        <StatusLabel status="clarification" />
        <StatusLabel status="undone" />
      </>,
    )
    expect(screen.queryByRole('status')).toBeNull()
    const icons = container.querySelectorAll('svg')
    expect(icons).toHaveLength(2)
    for (const icon of Array.from(icons)) expect(icon).toHaveAttribute('aria-hidden', 'true')
    // Struck through by style, not as a deletion a screen reader announces.
    expect(container.querySelector('del, s')).toBeNull()
    expect(screen.getByText('zurückgenommen')).toBeVisible()
  })
})

describe('statusKey', () => {
  const ref = (patch: Partial<ModelActionView>, level?: 'Assistenz' | 'Teilautonom') =>
    actionView('reference', patch, level)

  // One row per ActionStatus: the type makes the table exhaustive.
  const BY_STATUS: Record<ActionStatus, [ModelActionView, StatusKey][]> = {
    thinking: [[thinkingView('reference'), 'thinking']],
    refused: [[actionView('unknown_layer'), 'refused']],
    answered: [
      [actionView('clarification'), 'clarification'],
      [actionView('cannot_answer'), 'message'],
    ],
    proposed: [
      [actionView('reference'), 'awaiting'],
      [actionView('reference', {}, 'Assistenz'), 'proposal'],
    ],
    // The mocks send ``proposed`` before enforcement (P1), as the E2.3 server does.
    approved: [[ref({ status: 'approved' }, 'Teilautonom'), 'approved']],
    running: [[ref({ approach: 'chain', status: 'running' }), 'running']],
    done: [[ref({ status: 'done' }), 'done']],
    limited: [
      [ref({ status: 'limited', stop_reason: 'time_limit' }), 'limited'],
      [ref({ status: 'limited', stop_reason: 'result_too_large' }), 'limited'],
      [ref({ status: 'limited', stop_reason: 'aborted' }), 'aborted'],
      [ref({ status: 'limited', stop_reason: 'interrupted' }), 'aborted'],
    ],
    applied: [
      [ref({ status: 'applied', decision: 'accepted' }), 'applied'],
      [ref({ status: 'applied', decision: 'auto' }, 'Teilautonom'), 'auto'],
      [ref({ status: 'applied', decision: 'adjusted' }), 'by_hand'],
      [ref({ status: 'applied', decision: 'proposal_only', applied_by_hand: true }), 'by_hand'],
    ],
    rejected: [[ref({ status: 'rejected', decision: 'rejected' }), 'rejected']],
    superseded: [[ref({ status: 'superseded', decision: 'superseded' }), 'superseded']],
    undone: [[ref({ status: 'undone', decision: 'auto' }), 'undone']],
    aborted: [[actionView('aborted'), 'aborted']],
    failed: [[actionView('unreachable'), 'error']],
  }

  test.each(
    Object.entries(BY_STATUS).flatMap(([status, rows]) =>
      rows.map(([view, key]) => [status, key, view] as const),
    ),
  )('%s → %s (with enforcement, E2.4)', (status, key, view) => {
    expect(view.status).toBe(status)
    expect(statusKey(view, { proposalOnly: false })).toBe(key)
  })

  test.skipIf(ENFORCEMENT)('before enforcement (P1) nothing waits for an approval', () => {
    expect(statusKey(actionView('reference'))).toBe('proposal')
    expect(statusKey(actionView('reference'), { proposalOnly: true })).toBe('proposal')
    expect(statusKey(ref({ status: 'applied', decision: 'accepted' }))).toBe('applied')
  })

  test('stale (M11.3) wins', () => {
    expect(statusKey(actionView('reference'), { stale: true })).toBe('stale')
  })
})
