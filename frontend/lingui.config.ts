// Message catalogs (plan E1.9, L1): German is the source and, for now, the only
// language; "pseudo" shows untranslated text and tight layouts (L7).
import { formatter } from '@lingui/format-po'
import { defineConfig } from '@lingui/conf'

export default defineConfig({
  sourceLocale: 'de',
  locales: ['de', 'pseudo'],
  pseudoLocale: { locale: 'pseudo', prepend: '⟦', append: '⟧', extend: 0.3 },
  fallbackLocales: { default: 'de' },
  catalogs: [
    {
      path: '<rootDir>/src/locales/{locale}',
      include: ['<rootDir>/src'],
      exclude: ['**/*.test.*', '<rootDir>/src/test/**'],
    },
  ],
  // Without line numbers, moving code does not touch the catalog.
  format: formatter({ lineNumbers: false }),
})
