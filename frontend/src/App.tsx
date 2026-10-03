import { useEffect } from 'react'
import { NavLink, Navigate, Outlet, Route, Routes, useLocation, useParams } from 'react-router'
import { AdminLayout } from './admin/AdminLayout'
import { CatalogPage } from './admin/CatalogPage'
import { ImportLogPage } from './admin/ImportLogPage'
import { ImportRunPage } from './admin/ImportRunPage'
import { ImportWizard } from './admin/ImportWizard'
import { LayerPage } from './admin/LayerPage'
import { SystemPage } from './admin/SystemPage'
import { UsersPage } from './admin/UsersPage'
import { VisibilityPage } from './admin/VisibilityPage'
import { useMe } from './api/queries'
import { RequireAccount, RequireAdmin, RequireSession } from './auth/guards'
import { LoginPage } from './auth/LoginPage'
import { PasswordPage } from './auth/PasswordPage'
import { SetupPage } from './auth/SetupPage'
import { UserMenu } from './auth/UserMenu'
import { useAnalysis } from './analysis/store'
import { SessionMenu } from './session/SessionMenu'
import { SessionDialogs } from './session/SessionDialogs'
import { isUnsaved, saveOrAsk } from './session/ui'
import { useSessionRoute } from './session/useSessionRoute'
import { Workplace } from './workplace/Workplace'

const link = ({ isActive }: { isActive: boolean }) =>
  `font-heading border-b-2 px-1 text-[17px] font-semibold ${isActive ? 'border-accent' : 'border-transparent hover:border-neutral-400'}`

const onWorkplace = (path: string) => path === '/' || path.startsWith('/sitzung/')

function Shell() {
  const me = useMe()
  const { pathname } = useLocation()
  const workplace = onWorkplace(pathname)

  // ⌘S / Ctrl+S saves (design C1); leaving the page with unsaved changes asks (C5).
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!workplace || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return
      event.preventDefault()
      void saveOrAsk()
    }
    const beforeunload = (event: BeforeUnloadEvent) => {
      if (isUnsaved(useAnalysis.getState())) event.preventDefault()
    }
    window.addEventListener('keydown', keydown)
    window.addEventListener('beforeunload', beforeunload)
    return () => {
      window.removeEventListener('keydown', keydown)
      window.removeEventListener('beforeunload', beforeunload)
    }
  }, [workplace])

  return (
    <div className="flex h-screen flex-col">
      <header className="border-divider flex items-center gap-6 border-b px-4 py-2">
        <span className="font-heading text-xl font-semibold tracking-tight">GeoTandem</span>
        {workplace && <SessionMenu />}
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
      <SessionDialogs />
    </div>
  )
}

function WorkplaceRoute() {
  const { id } = useParams()
  useSessionRoute(id)
  return <Workplace />
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
            <Route path="/" element={<WorkplaceRoute />} />
            <Route path="/sitzung/:id" element={<WorkplaceRoute />} />
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
              <Route path="system" element={<SystemPage />} />
            </Route>
            <Route path="*" element={<p>Diese Seite gibt es nicht.</p>} />
          </Route>
        </Route>
      </Route>
    </Routes>
  )
}
