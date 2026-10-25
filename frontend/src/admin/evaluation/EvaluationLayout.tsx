// Administration › Modell › Bewertung (design V1, V5): the tabs Läufe and
// Prüffälle above the page. Läufe is WP93's; until then it holds a placeholder
// and the navigation enters on Prüffälle (WP93 switches the entry to Läufe,
// the design's default).
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { Link, NavLink, Outlet } from 'react-router'

const tab = ({ isActive }: { isActive: boolean }) =>
  `tab text-sm ${isActive ? 'text-accent-700' : 'hover:text-accent-700'}`

export function EvaluationLayout() {
  return (
    <section aria-labelledby="evaluation-title">
      <h2 id="evaluation-title" className="mb-2 text-2xl">
        <Trans>Bewertung</Trans>
      </h2>
      <nav
        aria-label={t`Bewertung`}
        className="mb-4 flex gap-4 border-b border-[var(--color-divider)]"
      >
        <NavLink to="/admin/bewertung" end className={tab}>
          <Trans>Läufe</Trans>
        </NavLink>
        <NavLink to="/admin/bewertung/faelle" end className={tab}>
          <Trans>Prüffälle</Trans>
        </NavLink>
      </nav>
      <Outlet />
    </section>
  )
}

/** Läufe (V5) until WP93 builds it. */
export function RunsPlaceholder() {
  return (
    <p className="text-muted text-sm">
      <Trans>
        Bewertungsläufe folgen in einem nächsten Schritt. Die Prüffälle dafür lassen sich schon
        jetzt anlegen, importieren und prüfen:{' '}
        <Link to="/admin/bewertung/faelle" className="text-accent-700">
          Prüffälle
        </Link>
        .
      </Trans>
    </p>
  )
}
