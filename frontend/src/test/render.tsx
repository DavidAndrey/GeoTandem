import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { vi } from 'vitest'

export function renderAt(path: string, ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
      </QueryClientProvider>
    </I18nProvider>,
  )
}

type Handler = (init: RequestInit | undefined, url: string) => unknown

/** A fake backend: "METHOD /path" → JSON body (or a Response). Records every call. */
export function fakeApi(routes: Record<string, Handler | object>) {
  const calls: { key: string; body: unknown }[] = []
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://test')
    const key = `${init?.method ?? 'GET'} ${url.pathname}`
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body
    calls.push({ key, body })
    const route = routes[key]
    if (route === undefined)
      return new Response('{"code":"not_found","message":"?"}', { status: 404 })
    const result = typeof route === 'function' ? (route as Handler)(init, input) : route
    return result instanceof Response ? result : new Response(JSON.stringify(result))
  })
  vi.stubGlobal('fetch', fetch)
  return calls
}
