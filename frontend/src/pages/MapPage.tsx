import { useEffect, useState } from 'react'
import { layerType } from '../admin/format'
import { api, type Health } from '../api/client'
import { useLayers } from '../api/queries'
import { ErrorNotice } from '../components/ui'

// Placeholder until E1.5 brings the map: shows that the backend is reachable
// and which layers this account may see (F-2.7).
export function MapPage() {
  const [health, setHealth] = useState<Health>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    api.health().then(setHealth, (e: Error) => setError(e.message))
  }, [])

  if (error) return <p role="alert">Backend nicht erreichbar: {error}</p>
  if (!health) return <p>Verbinde …</p>
  return (
    <div className="flex flex-wrap items-start gap-5">
      <section aria-label="Systemstatus" className="card max-w-md p-4">
        <h1 className="mb-2 text-2xl">Systemstatus</h1>
        <dl className="grid grid-cols-2 gap-y-1 text-sm">
          <dt>Status</dt>
          <dd>{health.status === 'ok' ? 'Bereit' : 'Eingeschränkt'}</dd>
          <dt>Datenkern</dt>
          <dd>{health.backend}</dd>
          <dt>Internes CRS</dt>
          <dd>EPSG:{health.internal_crs}</dd>
          <dt>Abfrageschema</dt>
          <dd>v{health.schema_version}</dd>
          <dt>Beispieldatensatz</dt>
          <dd>{health.sample_dataset_version}</dd>
        </dl>
      </section>
      <AvailableLayers />
    </div>
  )
}

function AvailableLayers() {
  const layers = useLayers()
  return (
    <section aria-label="Verfügbare Layer" className="card max-w-md min-w-64 p-4">
      <h2 className="mb-2 text-2xl">Verfügbare Layer</h2>
      <ErrorNotice error={layers.error} />
      <ul className="text-sm">
        {layers.data?.map((layer) => (
          <li key={layer.name} className="flex justify-between gap-4">
            <span>{layer.title}</span>
            <span className="text-muted">{layerType(layer)}</span>
          </li>
        ))}
      </ul>
      {layers.data?.length === 0 && <p className="text-muted text-sm">Keine Layer freigegeben.</p>}
    </section>
  )
}
