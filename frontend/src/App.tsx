import { NavLink, Navigate, Outlet, Route, Routes } from 'react-router'
import { AdminLayout } from './admin/AdminLayout'
import { CatalogPage } from './admin/CatalogPage'
import { ImportLogPage } from './admin/ImportLogPage'
import { ImportRunPage } from './admin/ImportRunPage'
import { ImportWizard } from './admin/ImportWizard'
import { LayerPage } from './admin/LayerPage'
import { UsersPage } from './admin/UsersPage'
import { VisibilityPage } from './admin/VisibilityPage'
import { useMe } from './api/queries'
import { RequireAccount, RequireAdmin, RequireSession } from './auth/guards'
import { LoginPage } from './auth/LoginPage'
import { PasswordPage } from './auth/PasswordPage'
import { SetupPage } from './auth/SetupPage'
import { UserMenu } from './auth/UserMenu'
import { MapPage } from './pages/MapPage'

const link = ({ isActive }: { isActive: boolean }) =>
  `font-heading border-b-2 px-1 text-[17px] font-semibold ${isActive ? 'border-accent' : 'border-transparent hover:border-neutral-400'}`

function Shell() {
  const me = useMe()
  return (
    <div className="flex h-screen flex-col">
      <header className="border-divider flex items-center gap-6 border-b px-4 py-2">
        <span className="font-heading text-xl font-semibold tracking-tight">GeoTandem</span>
        <nav className="flex gap-4" aria-label="Hauptnavigation">
          <NavLink to="/" end className={link}>
            Karte
          </NavLink>
          {me.data?.role === 'admin' && (
            <NavLink to="/admin" className={link}>
              Administration
            </NavLink>
          )}
        </nav>
        <div className="ml-auto">{me.data && <UserMenu account={me.data} />}</div>
      </header>
      <main className="flex-1 overflow-auto p-5">
        <Outlet />
      </main>
    </div>
  )
}

export function App() {
  return (
    <Routes>
      <Route path="/einrichtung" element={<SetupPage />} />
      <Route path="/anmelden" element={<LoginPage />} />
      <Route element={<RequireSession />}>
        <Route path="/passwort" element={<PasswordPage />} />
        <Route element={<RequireAccount />}>
          <Route element={<Shell />}>
            <Route path="/" element={<MapPage />} />
            <Route
              path="/admin"
              element={
                <RequireAdmin>
                  <AdminLayout />
                </RequireAdmin>
              }
            >
              <Route index element={<Navigate to="daten" replace />} />
              <Route path="daten" element={<CatalogPage />} />
              <Route path="daten/import" element={<ImportWizard />} />
              <Route path="daten/:layer" element={<LayerPage />} />
              <Route path="protokoll" element={<ImportLogPage />} />
              <Route path="protokoll/:id" element={<ImportRunPage />} />
              <Route path="benutzer" element={<UsersPage />} />
              <Route path="sichtbarkeit" element={<VisibilityPage />} />
            </Route>
            <Route path="*" element={<p>Diese Seite gibt es nicht.</p>} />
          </Route>
        </Route>
      </Route>
    </Routes>
  )
}
