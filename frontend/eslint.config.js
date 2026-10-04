import js from '@eslint/js'
import lingui from 'eslint-plugin-lingui'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default defineConfig([
  globalIgnores(['dist', 'src/api/schema.d.ts']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.strict,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: { globals: globals.browser },
  },
  {
    // Every visible text goes through the catalog (plan E1.9). Tests read German.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/**/*.test.*', 'src/test/**'],
    extends: [lingui.configs['flat/recommended']],
    rules: {
      // A condition is one message of placeholders on purpose (plan E1.9, WP48).
      'lingui/no-single-variables-to-translate': 'off',
      'lingui/no-unlocalized-strings': [
        'warn',
        {
          // Flagged: text with a capital or a space. Not: identifiers, keys,
          // class lists (lowercase with a dash), paths, symbols and numbers.
          ignore: [
            '^[^A-ZÄÖÜ\\s]*$',
            '^[A-Z0-9_]+$',
            '^[a-z]+([A-Z][a-z]*)+$',
            '^(?=.*-)[a-z0-9:\\[\\]\\-/.%!_#()=> ]+$',
            // Locale tags and the product name.
            '^[a-z]{2}-[A-Z]{2}$',
            '^GeoTandem$',
            '^⌘',
            '^EPSG:',
          ],
          ignoreNames: [
            {
              regex: {
                pattern: '^(className|key|to|id|type|role|name|href|src|path|method|mode)$',
              },
            },
            {
              regex: {
                pattern: '^(aria-hidden|data-.*|htmlFor|autoComplete|inputMode|align|side)$',
              },
            },
          ],
          // Errors are not exempt: their message is shown (e.g. a saved query
          // that cannot open).
          ignoreFunctions: [
            'console.*',
            'navigate',
            'document.querySelector*',
            'URLSearchParams',
            '*.includes',
            '*.startsWith',
            '*.pm.enableDraw',
          ],
        },
      ],
    },
  },
])
