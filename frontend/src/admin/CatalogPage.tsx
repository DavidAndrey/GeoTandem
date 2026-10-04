// Data catalog with import status (design D2, F-2.7).
import { actionsFor } from '../i18n/phrases'
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import type { AdminLayerInfo } from '../api/client'
import { useAdminLayers } from '../api/queries'
import { Dots, ErrorNotice, Loading, Menu, MenuItem, StatusBadge } from '../components/ui'
import { DeleteLayerDialog } from './DeleteLayerDialog'
import { DuplicateLayerDialog } from './DuplicateLayerDialog'
import { completeness, formatDate, layerType, sourceLabel } from './format'

type Filter = 'all' | 'incomplete'

export function CatalogPage() {
  const layers = useAdminLayers()
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [deleting, setDeleting] = useState<AdminLayerInfo>()
  const [duplicating, setDuplicating] = useState<AdminLayerInfo>()

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
          <Trans>Datenkatalog</Trans>
        </h2>
        <input
          type="search"
          className="input w-56"
          placeholder={t`Layer suchen`}
          aria-label={t`Layer suchen`}
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
            {value === 'all' ? t`Alle` : t`Unvollständig`}
          </button>
        ))}
        <Link to="/admin/daten/import" className="btn btn-primary ml-auto">
          <Plus size={14} aria-hidden /> <Trans>Importieren</Trans>
        </Link>
      </div>

      {layers.isPending && <Loading />}
      <ErrorNotice error={layers.error} />
      {layers.data && (
        <table className="data-table">
          <thead>
            <tr>
              <th>
                <Trans>Layer</Trans>
              </th>
              <th>
                <Trans>Typ</Trans>
              </th>
              <th>
                <Trans>Quelle</Trans>
              </th>
              <th>
                <Trans>Stand</Trans>
              </th>
              <th className="text-right">
                <Trans>Objekte</Trans>
              </th>
              <th>
                <Trans>Metadaten</Trans>
              </th>
              <th>
                <Trans>Für Modell</Trans>
              </th>
              <th>
                <Trans>Letzter Import</Trans>
              </th>
              <th>
                <span className="sr-only">
                  <Trans>Aktionen</Trans>
                </span>
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
                  <Dots value={completeness(layer)} label={t`Metadaten`} />
                </td>
                <td>{layer.for_model ? t`ja` : t`nein`}</td>
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
                  <Menu label={actionsFor(layer.title)}>
                    <MenuItem onSelect={() => navigate(`/admin/daten/${layer.name}`)}>
                      <Trans>Öffnen</Trans>
                    </MenuItem>
                    <MenuItem onSelect={() => navigate(`/admin/daten/import?ziel=${layer.name}`)}>
                      <Trans>Aktualisieren</Trans>
                    </MenuItem>
                    <MenuItem onSelect={() => setDuplicating(layer)}>
                      <Trans>Duplizieren</Trans>
                    </MenuItem>
                    <MenuItem danger onSelect={() => setDeleting(layer)}>
                      <Trans>Löschen</Trans>
                    </MenuItem>
                  </Menu>
                </td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={9} className="text-muted py-4 text-center">
                  {layers.data.length === 0 ? t`Der Katalog ist leer.` : t`Kein Layer passt.`}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
      {deleting && <DeleteLayerDialog layer={deleting} onClose={() => setDeleting(undefined)} />}
      {duplicating && (
        <DuplicateLayerDialog
          layer={duplicating}
          onClose={(copy) => {
            setDuplicating(undefined)
            if (copy) navigate(`/admin/daten/${copy}`)
          }}
        />
      )}
    </section>
  )
}
