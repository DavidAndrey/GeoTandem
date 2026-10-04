// Before the suite: generate the import test files and sign in as administrator.
import { request, type FullConfig } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const FILES_DIR = fileURLToPath(new URL('./.files/', import.meta.url))
export const ADMIN_STATE = fileURLToPath(new URL('./.auth/admin.json', import.meta.url))

/** The installation's setup token (its log, or GEOTANDEM_SETUP_TOKEN); only for a fresh instance. */
const SETUP_TOKEN = process.env.E2E_SETUP_TOKEN ?? ''

/** The first administrator on a fresh instance; on an existing one, set these to sign in. */
export const ADMIN = {
  username: process.env.E2E_ADMIN_USER ?? 'admin',
  password: process.env.E2E_ADMIN_PASSWORD ?? 'e2e-aare-bruecke-morgen',
}

export default async function globalSetup(config: FullConfig) {
  // Same generator as the pytest fixtures (backend/tests/import_files.py).
  const root = fileURLToPath(new URL('..', import.meta.url))
  execFileSync('uv', ['run', 'python', 'backend/tests/import_files.py', FILES_DIR], {
    cwd: root,
    stdio: 'ignore',
  })

  const { baseURL, ignoreHTTPSErrors } = config.projects[0]?.use ?? {}
  const api = await request.newContext({ baseURL, ignoreHTTPSErrors })
  const setup = await (await api.get('/api/auth/setup')).json()
  const response = setup.needs_setup
    ? await api.post('/api/auth/setup', {
        data: { ...ADMIN, token: SETUP_TOKEN, load_sample: true },
      })
    : await api.post('/api/auth/login', { data: ADMIN })
  if (!response.ok()) throw new Error(`cannot sign in as ${ADMIN.username}: ${await response.text()}`)
  await api.storageState({ path: ADMIN_STATE })
  await api.dispose()
}
