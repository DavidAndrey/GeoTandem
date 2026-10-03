// Data catalog with import status (design D2, F-2.7).
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import type { AdminLayerInfo } from '../api/client'
import { useAdminLayers } from '../api/queries'
import { Dots, ErrorNotice, Loading, Menu, MenuItem, StatusBadge } from '../components/ui'
import { DeleteLayerDialog } from './DeleteLayerDialog'
import { completeness, formatDate, layerType, sourceLabel } from './format'

type Filter = 'all' | 'incomplete'

export function CatalogPage() {
  const layers = useAdminLayers()
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [deleting, setDeleting] = useState<AdminLayerInfo>()

  const needle = search.trim().toLowerCase()
  const shown = (layers.data ?? []).filter(
    (layer) =>
      (!needle || `${layer.title} ${layer.name}`.toLowerCase().includes(needle)) &&
      (filter === 'all' || completeness(layer) < 4),
  )

  return (
    <section aria-labelledby="catalog-title">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 id="catalog-title" className="text-2xl">
          Datenkatalog
        </h2>
        <input
          type="search"
          className="input w-56"
          placeholder="Layer suchen"
          aria-label="Layer suchen"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {(['all', 'incomplete'] as const).map((value) => (
          <button
            key={value}
            type="button"
            className={`chip ${filter === value ? 'chip-active' : ''}`}
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
          >
            {value === 'all' ? 'Alle' : 'Unvollständig'}
          </button>
        ))}
        <Link to="/admin/daten/import" className="btn btn-primary ml-auto">
          <Plus size={14} aria-hidden /> Importieren
        </Link>
      </div>

      {layers.isPending && <Loading />}
      <ErrorNotice error={layers.error} />
      {layers.data && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Layer</th>
              <th>Typ</th>
              <th>Quelle</th>
              <th>Stand</th>
              <th className="text-right">Objekte</th>
              <th>Metadaten</th>
              <th>Für Modell</th>
              <th>Letzter Import</th>
              <th>
                <span className="sr-only">Aktionen</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((layer) => (
              <tr key={layer.name}>
                <td>
                  <Link to={`/admin/daten/${layer.name}`} className="hover:text-accent-700">
                    {layer.title}
                  </Link>
                  <div className="text-muted text-xs">{layer.name}</div>
                </td>
                <td>{layerType(layer)}</td>
                <td>{sourceLabel(layer.source)}</td>
                <td>{formatDate(layer.updated_at ?? layer.created_at)}</td>
                <td className="text-right">{layer.feature_count}</td>
                <td>
                  <Dots value={completeness(layer)} label="Metadaten" />
                </td>
                <td>{layer.for_model ? 'ja' : 'nein'}</td>
                <td>
                  {layer.last_import ? (
                    <Link to={`/admin/protokoll/${layer.last_import.id}`}>
                      <StatusBadge status={layer.last_import.status} />
                    </Link>
                  ) : (
                    '–'
                  )}
                </td>
                <td className="text-right">
                  <Menu label={`Aktionen für ${layer.title}`}>
                    <MenuItem onSelect={() => navigate(`/admin/daten/${layer.name}`)}>
                      Öffnen
                    </MenuItem>
                    <MenuItem onSelect={() => navigate(`/admin/daten/import?ziel=${layer.name}`)}>
                      Aktualisieren
                    </MenuItem>
                    <MenuItem danger onSelect={() => setDeleting(layer)}>
                      Löschen
                    </MenuItem>
                  </Menu>
                </td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={9} className="text-muted py-4 text-center">
                  {layers.data.length === 0 ? 'Der Katalog ist leer.' : 'Kein Layer passt.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
      {deleting && <DeleteLayerDialog layer={deleting} onClose={() => setDeleting(undefined)} />}
    </section>
  )
}
