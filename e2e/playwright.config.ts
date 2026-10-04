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
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
