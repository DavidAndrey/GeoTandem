import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setNonce } from 'get-nonce'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import { App } from './App'
import { ApiRequestError } from './api/client'
import { keys } from './api/queries'
import { setupI18n } from './i18n/i18n'
import './index.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root missing in index.html')

// Dialogs lock scrolling with <style> elements they add at run time; the
// Content-Security-Policy admits them only with the page's nonce (security review #7).
const nonce = document.querySelector<HTMLMetaElement>('meta[property="csp-nonce"]')?.nonce
if (nonce) setNonce(nonce)

// A 401 anywhere means the session ended (expired, locked, signed out
// elsewhere): re-asking "who am I" sends the guards to the sign-in page.
const onError = (error: unknown) => {
  if (error instanceof ApiRequestError && error.status === 401)
    void queryClient.invalidateQueries({ queryKey: keys.me })
}

const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({ onError }),
  mutationCache: new MutationCache({ onError }),
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: (count, error) =>
        !(error instanceof ApiRequestError && error.status < 500) && count < 1,
    },
  },
})

void setupI18n(window.location.search).then(() =>
  createRoot(root).render(
    <StrictMode>
      <I18nProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </QueryClientProvider>
      </I18nProvider>
    </StrictMode>,
  ),
)
