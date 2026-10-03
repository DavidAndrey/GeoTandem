// System status for administrators: data core, internal CRS, schema and sample
// versions (formerly the start page placeholder of E1.1 to E1.4).
import { useEffect, useState } from 'react'
import { api, type Health } from '../api/client'

export function SystemPage() {
  const [health, setHealth] = useState<Health>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    api.health().then(setHealth, (e: Error) => setError(e.message))
  }, [])

  if (error) return <p role="alert">Backend nicht erreichbar: {error}</p>
  if (!health) return <p>Verbinde …</p>
  return (
    <section aria-label="Systemstatus" className="card max-w-md p-4">
      <h2 className="mb-2 text-2xl">Systemstatus</h2>
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
