import { NavLink, Route, Routes } from 'react-router'
import { AdminPage } from './pages/AdminPage'
import { MapPage } from './pages/MapPage'

const link = ({ isActive }: { isActive: boolean }) =>
  `rounded px-3 py-1.5 text-sm ${isActive ? 'bg-blue-700 text-white' : 'text-slate-700 hover:bg-slate-200'}`

export function App() {
  return (
    <div className="flex h-screen flex-col bg-slate-50 text-slate-900">
      <header className="flex items-center gap-4 border-b border-slate-200 bg-white px-4 py-2">
        <span className="font-semibold tracking-tight">GeoTandem</span>
        <nav className="flex gap-1" aria-label="Hauptnavigation">
          <NavLink to="/" end className={link}>
            Karte
          </NavLink>
          <NavLink to="/admin" className={link}>
            Administration
          </NavLink>
        </nav>
      </header>
      <main className="flex-1 overflow-auto p-4">
        <Routes>
          <Route path="/" element={<MapPage />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="*" element={<p>Diese Seite gibt es nicht.</p>} />
        </Routes>
      </main>
    </div>
  )
}
