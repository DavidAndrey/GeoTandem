import { defineConfig, devices } from '@playwright/test'

// Runs against a running instance, by default the container from `make docker`:
//   docker run -p 8000:8000 -v geotandem-data:/data geotandem
export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8000',
    // E.g. through a local Traefik with its self-signed default certificate.
    ignoreHTTPSErrors: process.env.E2E_IGNORE_HTTPS_ERRORS === '1',
    // Signed in as administrator by global-setup.ts; tests that need another
    // account or none start their own context.
    storageState: './.auth/admin.json',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      grepInvert: /@llm|@stub/,
    },
    // Tests that enable a model connection change what every account sees: they
    // run alone, after all others (E2.1 with a real model, scripts/gate.sh).
    {
      name: 'llm',
      use: { ...devices['Desktop Chrome'] },
      grep: /@llm/,
      dependencies: ['chromium'],
    },
    // Modus B against the model stub (e2e/model-stub, from E2.3 on): its
    // connections would otherwise become the default the E2.1 test expects
    // to set itself, so it runs after that one. One file at a time: the suites
    // change the levels every account shares (E2.4 puts spatial on Freigabe
    // for Teilautonom while E2.5 expects it on auto).
    {
      name: 'stub',
      use: { ...devices['Desktop Chrome'] },
      grep: /@stub/,
      dependencies: ['llm'],
      workers: 1,
    },
  ],
})
