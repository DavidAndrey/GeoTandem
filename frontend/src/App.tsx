import { NavLink, Navigate, Route, Routes } from 'react-router'
import { AdminLayout } from './admin/AdminLayout'
import { CatalogPage } from './admin/CatalogPage'
import { ImportLogPage } from './admin/ImportLogPage'
import { ImportRunPage } from './admin/ImportRunPage'
import { ImportWizard } from './admin/ImportWizard'
import { LayerPage } from './admin/LayerPage'
import { MapPage } from './pages/MapPage'

const link = ({ isActive }: { isActive: boolean }) =>
  `font-heading border-b-2 px-1 text-[17px] font-semibold ${isActive ? 'border-accent' : 'border-transparent hover:border-neutral-400'}`

export function App() {
  return (
    <div className="flex h-screen flex-col">
      <header className="border-divider flex items-center gap-6 border-b px-4 py-2">
        <span className="font-heading text-xl font-semibold tracking-tight">GeoTandem</span>
        <nav className="flex gap-4" aria-label="Hauptnavigation">
          <NavLink to="/" end className={link}>
            Karte
          </NavLink>
          <NavLink to="/admin" className={link}>
            Administration
          </NavLink>
        </nav>
      </header>
      <main className="flex-1 overflow-auto p-5">
        <Routes>
          <Route path="/" element={<MapPage />} />
          <Route path="/admin" element={<AdminLayout />}>
            <Route index element={<Navigate to="daten" replace />} />
            <Route path="daten" element={<CatalogPage />} />
            <Route path="daten/import" element={<ImportWizard />} />
            <Route path="daten/:layer" element={<LayerPage />} />
            <Route path="protokoll" element={<ImportLogPage />} />
            <Route path="protokoll/:id" element={<ImportRunPage />} />
          </Route>
          <Route path="*" element={<p>Diese Seite gibt es nicht.</p>} />
        </Routes>
      </main>
    </div>
  )
}
