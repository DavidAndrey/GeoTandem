import { useEffect, useState } from 'react'
import { api, type Health } from '../api/client'

// Placeholder until E1.5 brings the map; shows that the backend is reachable.
export function MapPage() {
  const [health, setHealth] = useState<Health>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    api.health().then(setHealth, (e: Error) => setError(e.message))
  }, [])

  if (error) return <p role="alert">Backend nicht erreichbar: {error}</p>
  if (!health) return <p>Verbinde …</p>
  return (
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
  )
}
