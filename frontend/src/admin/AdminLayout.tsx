// Administration frame (design D1): side navigation plus the current page.
import { NavLink, Outlet } from 'react-router'

const groups: { title: string; links: { to?: string; label: string; from?: string }[] }[] = [
  {
    title: 'Daten',
    links: [
      { to: '/admin/daten', label: 'Datenkatalog' },
      { to: '/admin/protokoll', label: 'Importprotokoll' },
    ],
  },
  {
    title: 'Zugang',
    links: [
      { to: '/admin/benutzer', label: 'Benutzer' },
      { to: '/admin/sichtbarkeit', label: 'Sichtbarkeit' },
    ],
  },
  {
    title: 'Betrieb',
    links: [{ to: '/admin/system', label: 'System' }],
  },
  {
    title: 'Später',
    links: [
      { label: 'Modelle', from: 'E2' },
      { label: 'Bewertung', from: 'E3' },
      { label: 'MCP', from: 'E4' },
    ],
  },
]

const link = ({ isActive }: { isActive: boolean }) =>
  `block border-l-2 py-0.5 pl-2 ${isActive ? 'border-accent text-accent-700' : 'border-transparent hover:text-accent-700'}`

export function AdminLayout() {
  return (
    <div className="flex min-h-full gap-6">
      <nav aria-label="Administration" className="w-[170px] shrink-0">
        <h1 className="mb-3 text-2xl">Administration</h1>
        {groups.map((group) => (
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
                      title={`ab ${item.from}`}
                    >
                      {item.label} <span className="text-xs">ab {item.from}</span>
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
