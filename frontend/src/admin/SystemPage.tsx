// System status for administrators: data core, internal CRS, schema and sample
// versions (formerly the start page placeholder of E1.1 to E1.4). Only here:
// /api/health tells everyone else no more than ready or not (security review #10).
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { useEffect, useState } from 'react'
import { api, type SystemStatus } from '../api/client'

export function SystemPage() {
  const [health, setHealth] = useState<SystemStatus>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    api.admin.system().then(setHealth, (e: Error) => setError(e.message))
  }, [])

  if (error)
    return (
      <p role="alert">
        <Trans>Backend nicht erreichbar: {error}</Trans>
      </p>
    )
  if (!health)
    return (
      <p>
        <Trans>Verbinde …</Trans>
      </p>
    )
  return (
    <section aria-label={t`Systemstatus`} className="card max-w-md p-4">
      <h2 className="mb-2 text-2xl">
        <Trans>Systemstatus</Trans>
      </h2>
      <dl className="grid grid-cols-2 gap-y-1 text-sm">
        <dt>
          <Trans>Status</Trans>
        </dt>
        <dd>{health.status === 'ok' ? t`Bereit` : t`Eingeschränkt`}</dd>
        <dt>
          <Trans>Datenkern</Trans>
        </dt>
        <dd>{health.backend}</dd>
        <dt>
          <Trans>Internes CRS</Trans>
        </dt>
        <dd>EPSG:{health.internal_crs}</dd>
        <dt>
          <Trans>Abfrageschema</Trans>
        </dt>
        <dd>v{health.schema_version}</dd>
        <dt>
          <Trans>Beispieldatensatz</Trans>
        </dt>
        <dd>{health.sample_dataset_version}</dd>
      </dl>
    </section>
  )
}
