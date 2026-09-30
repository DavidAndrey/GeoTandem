import { defineConfig, devices } from '@playwright/test'

// Runs against a running instance, by default the container from `make docker`:
//   docker run -p 8000:8000 -v geotandem-data:/data geotandem
export default defineConfig({
  testDir: './tests',
  use: { baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8000' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
