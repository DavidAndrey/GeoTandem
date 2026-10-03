import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { App } from '../App'
import { newSession } from '../session/actions'
import { useSessionUi } from '../session/ui'
import { signedIn } from '../test/fixtures'
import { fakeApi, renderAt } from '../test/render'
import { useMapView } from './view'

beforeEach(() => {
  newSession()
  useSessionUi.setState({ landed: true })
  useMapView.setState({ measuring: null })
  fakeApi({
    ...signedIn(),
    'GET /api/layers': [],
    'GET /api/config/map': {
      basemap: null,
      extent_wgs84: [7.3, 46.9, 7.5, 47],
      max_features: 10000,
    },
    'GET /api/sessions': [],
    'GET /api/sessions/last': () => null,
    'GET /api/queries': [],
  })
})
afterEach(() => vi.unstubAllGlobals())

test('measuring opens from the toolbar, switches between distance and area, and ends', async () => {
  renderAt('/', <App />)
  const toggle = await screen.findByRole('button', { name: 'Messen' })
  await userEvent.click(toggle)
  expect(toggle).toHaveAttribute('aria-pressed', 'true')
  const panel = await screen.findByRole('region', { name: 'Messen' })
  expect(within(panel).getByRole('status', { name: 'Messwert' })).toHaveTextContent('0.0 m')

  await userEvent.click(within(panel).getByRole('button', { name: 'Fläche' }))
  expect(useMapView.getState().measuring).toBe('area')
  // A new mode starts a new drawing, with its own panel.
  const area = await screen.findByRole('region', { name: 'Messen' })
  expect(within(area).getByRole('status', { name: 'Messwert' })).toHaveTextContent('–')

  // Escape on an empty drawing ends measuring.
  await userEvent.keyboard('{Escape}')
  expect(useMapView.getState().measuring).toBeNull()
  expect(screen.queryByRole('region', { name: 'Messen' })).not.toBeInTheDocument()
})
