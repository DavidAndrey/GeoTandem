/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The server puts a fresh nonce in place of this on every page load; the
  // Content-Security-Policy admits only styles carrying it (api/guards.py).
  html: { cspNonce: '__GEOTANDEM_CSP_NONCE__' },
  server: {
    // In development the backend runs separately (`make dev`).
    proxy: { '/api': 'http://127.0.0.1:8000' },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
  },
})
