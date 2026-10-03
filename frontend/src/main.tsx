import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import { App } from './App'
import { ApiRequestError } from './api/client'
import { keys } from './api/queries'
import './index.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root missing in index.html')

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

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
