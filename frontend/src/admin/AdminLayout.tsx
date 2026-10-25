// Administration frame (design D1): side navigation plus the current page.
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { Link, NavLink, Outlet, useLocation } from 'react-router'

type Group = {
  title: string
  /** ``within``: the link is active anywhere below this path, not only at ``to``. */
  links: { to?: string; label: string; from?: string; within?: string }[]
}

const groups = (): Group[] => [
  {
    title: t`Daten`,
    links: [
      { to: '/admin/daten', label: t`Datenkatalog` },
      { to: '/admin/protokoll', label: t`Importprotokoll` },
    ],
  },
  {
    title: t`Zugang`,
    links: [
      { to: '/admin/benutzer', label: t`Benutzer` },
      { to: '/admin/sichtbarkeit', label: t`Sichtbarkeit` },
    ],
  },
  {
    title: t`Modell`,
    links: [
      { to: '/admin/modelle', label: t`Modellanbindungen` },
      { to: '/admin/stufen', label: t`Stufen` },
      { to: '/admin/steckbrief', label: t`Was das Modell sieht` },
      { to: '/admin/modellprotokoll', label: t`Modellprotokoll` },
      // Enters on Läufe, the design's default tab (V5).
      { to: '/admin/bewertung', label: t`Bewertung`, within: '/admin/bewertung' },
    ],
  },
  {
    title: t`Betrieb`,
    links: [{ to: '/admin/system', label: t`System` }],
  },
  {
    title: t`Später`,
    links: [{ label: 'MCP', from: 'E4' }],
  },
]

const link = (active: boolean) =>
  `block border-l-2 py-0.5 pl-2 ${active ? 'border-accent text-accent-700' : 'border-transparent hover:text-accent-700'}`

/** "ab E2": the stage that brings it. */
const availableFrom = (stage = '') => t`ab ${stage}`

export function AdminLayout() {
  const { pathname } = useLocation()
  const within = (path: string) => pathname === path || pathname.startsWith(`${path}/`)
  return (
    <div className="flex min-h-full gap-6">
      <nav aria-label={t`Administration`} className="w-[170px] shrink-0">
        <h1 className="mb-3 text-2xl">
          <Trans>Administration</Trans>
        </h1>
        {groups().map((group) => (
          <div key={group.title} className="mb-4">
            <p className="label-caps mb-1">{group.title}</p>
            <ul>
              {group.links.map((item) => (
                <li key={item.label}>
                  {item.to && item.within !== undefined ? (
                    // Active on every page below ``within``, not only at ``to`` (NavLink
                    // would mark it at ``to`` only, also for assistive technology).
                    <Link
                      to={item.to}
                      aria-current={within(item.within) ? 'page' : undefined}
                      className={link(within(item.within))}
                    >
                      {item.label}
                    </Link>
                  ) : item.to ? (
                    <NavLink to={item.to} className={({ isActive }) => link(isActive)}>
                      {item.label}
                    </NavLink>
                  ) : (
                    <span
                      className="block border-l-2 border-transparent py-0.5 pl-2 opacity-45"
                      title={availableFrom(item.from)}
                    >
                      {item.label} <span className="text-xs">{availableFrom(item.from)}</span>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  )
}
