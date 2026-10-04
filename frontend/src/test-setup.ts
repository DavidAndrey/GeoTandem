import '@testing-library/jest-dom/vitest'
import { activate } from './i18n/i18n'

// Tests read German, the source language (plan E1.9, L8).
activate('de')

// jsdom has no layout; the map only needs the observer to exist.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
