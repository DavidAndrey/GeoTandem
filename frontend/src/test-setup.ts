import '@testing-library/jest-dom/vitest'

// jsdom has no layout; the map only needs the observer to exist.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
