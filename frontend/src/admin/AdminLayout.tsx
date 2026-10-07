// Administration frame (design D1): side navigation plus the current page.
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { NavLink, Outlet } from 'react-router'

type Group = { title: string; links: { to?: string; label: string; from?: string }[] }

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
    links: [{ to: '/admin/stufen', label: t`Stufen` }],
  },
  {
    title: t`Betrieb`,
    links: [{ to: '/admin/system', label: t`System` }],
  },
  {
    title: t`Später`,
    links: [
      { label: t`Modelle`, from: 'E2' },
      { label: t`Bewertung`, from: 'E3' },
      { label: 'MCP', from: 'E4' },
    ],
  },
]

const link = ({ isActive }: { isActive: boolean }) =>
  `block border-l-2 py-0.5 pl-2 ${isActive ? 'border-accent text-accent-700' : 'border-transparent hover:text-accent-700'}`

/** "ab E2": the stage that brings it. */
const availableFrom = (stage = '') => t`ab ${stage}`

export function AdminLayout() {
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
                  {item.to ? (
                    <NavLink to={item.to} className={link}>
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
