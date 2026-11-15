// Choice of the interface language: each one named in its own language, so
// anyone finds theirs whichever is active. Kept in the browser (i18n.ts).
import { i18n } from '@lingui/core'
import { useLingui } from '@lingui/react/macro'
import { chooseLanguage, LANGUAGES, type Locale } from '../i18n/i18n'

export function LanguageSwitch({ className }: { className?: string }) {
  // Reading ``i18n.locale`` through the hook re-renders this when it changes.
  const { t, i18n: active } = useLingui()
  const current = LANGUAGES.some((l) => l.locale === active.locale)
    ? (active.locale as Locale)
    : i18n.locale
  return (
    <select
      className={className ?? 'input w-auto py-1 text-sm'}
      aria-label={t`Sprache`}
      value={current}
      onChange={(e) => void chooseLanguage(e.target.value as 'de' | 'fr')}
    >
      {LANGUAGES.map(({ locale, name }) => (
        <option key={locale} value={locale} lang={locale}>
          {name}
        </option>
      ))}
    </select>
  )
}
