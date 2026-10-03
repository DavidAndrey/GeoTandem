import { screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { App } from './App'
import { renderAt } from './test/render'

afterEach(() => vi.unstubAllGlobals())

test('start page shows the backend status', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'ok',
          version: '0.1.0',
          backend: 'spatialite',
          internal_crs: 2056,
          schema_version: '0',
          sample_dataset_version: 'tandemtal-1',
          capabilities: { supported: [], missing: {} },
        }),
      ),
    ),
  )
  renderAt('/', <App />)
  expect(await screen.findByText('Bereit')).toBeInTheDocument()
  expect(screen.getByText('EPSG:2056')).toBeInTheDocument()
})

test('unreachable backend is reported, not swallowed', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 502 })))
  renderAt('/', <App />)
  expect(await screen.findByRole('alert')).toHaveTextContent('Backend nicht erreichbar')
})

test('navigation reaches the administration area', () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => {})),
  )
  renderAt('/admin', <App />)
  expect(screen.getByRole('heading', { name: 'Administration' })).toBeInTheDocument()
})
