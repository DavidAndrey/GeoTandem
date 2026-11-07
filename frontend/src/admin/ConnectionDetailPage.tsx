// One model connection on its own page (plan-connection-detail): a bar to go
// back, switch to another connection or start a new one, its state at a
// glance, and the form. Unsaved changes are confirmed before leaving (D3).
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { ArrowLeft, Plus } from 'lucide-react'
import { useCallback, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router'
import type { ConnectionInfo } from '../api/client'
import { useConnections } from '../api/queries'
import { useAskBeforeLeaving } from '../components/askBeforeLeaving'
import { LocalityBadge } from '../components/LocalityBadge'
import { ConfirmDialog, ErrorNotice, Loading } from '../components/ui'
import { errorText } from '../i18n/errors'
import { ConnectionForm } from './ConnectionForm'
import { LastRun, LastTest } from './connectionParts'
import { detailPath, LIST, NEW } from './connectionPaths'

/** Arrives just created: the form says "Gespeichert" (D4). */
type Arrival = { saved?: boolean } | null

function Status({ connection: c }: { connection: ConnectionInfo }) {
  return (
    <>
      {c.credentials_unreadable && (
        <p className="text-danger mb-1 text-xs">{errorText('credentials_unreadable')}</p>
      )}
      <dl className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
        <div className="flex items-center gap-1.5">
          <dt className="sr-only">
            <Trans>Art</Trans>
          </dt>
          <dd>
            <LocalityBadge locality={c.locality} host={c.host} />
          </dd>
        </div>
        <div className="flex items-center gap-1.5">
          <dt className="sr-only">
            <Trans>Für Anwender</Trans>
          </dt>
          <dd>
            <span>{c.enabled ? t`freigegeben` : t`nicht freigegeben`}</span>
            {c.is_default && (
              <span className="chip ml-2">
                <Trans>voreingestellt</Trans>
              </span>
            )}
          </dd>
        </div>
        <div className="flex items-center gap-1.5">
          <dt className="text-muted">
            <Trans>Letzter Test</Trans>
          </dt>
          <dd>
            <LastTest connection={c} />
          </dd>
        </div>
        <div className="flex items-center gap-1.5">
          <dt className="text-muted">
            <Trans>Zuletzt bewertet</Trans>
          </dt>
          <dd>
            <LastRun connection={c} />
          </dd>
        </div>
      </dl>
    </>
  )
}

export function ConnectionDetailPage() {
  const { id } = useParams()
  const fresh = id === undefined
  const navigate = useNavigate()
  const arrival = useLocation().state as Arrival
  const connections = useConnections()
  const connection = fresh ? undefined : connections.data?.find((c) => String(c.id) === id)

  const [dirty, setDirty] = useState(false)
  const [leaving, setLeaving] = useState<(() => void) | null>(null)
  const onDirty = useCallback((next: boolean) => setDirty(next), [])
  /** Leaves at once, or asks first while the form has unsaved changes. */
  const guard = (go: () => void) => (dirty ? setLeaving(() => go) : go())
  useAskBeforeLeaving(dirty, setLeaving)

  const title = fresh ? t`Neue Anbindung` : (connection?.name ?? t`Anbindung`)

  return (
    <section aria-labelledby="connection-title" className="max-w-5xl">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Link to={LIST} className="hover:text-accent-700 flex items-center gap-1 text-sm">
          <ArrowLeft size={14} aria-hidden /> <Trans>Alle Anbindungen</Trans>
        </Link>
        {connections.data && (
          <label className="flex items-center gap-2 text-sm">
            <span className="sr-only">
              <Trans>Anbindung wählen</Trans>
            </span>
            <select
              className="input"
              value={fresh ? 'neu' : (id ?? '')}
              onChange={(e) => {
                const next = e.target.value
                guard(() => navigate(next === 'neu' ? NEW : detailPath(Number(next))))
              }}
            >
              {!fresh && !connection && <option value={id}>{t`Anbindung`}</option>}
              {connections.data.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
              <option value="neu">{t`Neue Anbindung …`}</option>
            </select>
          </label>
        )}
        {!fresh && (
          <button
            type="button"
            className="btn btn-primary ml-auto"
            onClick={() => guard(() => navigate(NEW))}
          >
            <Plus size={14} aria-hidden /> <Trans>Neue Anbindung</Trans>
          </button>
        )}
      </div>

      <h2 id="connection-title" className="mb-2 text-2xl">
        {title}
      </h2>
      {connections.isPending && !fresh && <Loading />}
      <ErrorNotice error={connections.error} />
      {connection && <Status connection={connection} />}
      {!fresh && connections.data && !connection ? (
        <p className="text-sm">
          <Trans>
            Anbindung nicht gefunden. Vielleicht wurde sie gelöscht.{' '}
            <Link to={LIST} className="text-accent-700">
              Zur Liste der Anbindungen
            </Link>
          </Trans>
        </p>
      ) : (
        (fresh || connection) && (
          <ConnectionForm
            key={fresh ? 'neu' : id}
            connection={connection}
            saved={!!arrival?.saved}
            onDirty={onDirty}
            onCancel={() => guard(() => navigate(LIST))}
            onSaved={(stored) => {
              // A new one goes to its own page, where data release can be granted.
              if (fresh) navigate(detailPath(stored.id), { replace: true, state: { saved: true } })
            }}
          />
        )
      )}

      <ConfirmDialog
        open={leaving !== null}
        onOpenChange={(next) => !next && setLeaving(null)}
        title={t`Ungespeicherte Änderungen an der Anbindung verwerfen?`}
        confirm={t`Verwerfen`}
        onConfirm={() => {
          const go = leaving
          setLeaving(null)
          setDirty(false)
          go?.()
        }}
      >
        <Trans>Die Änderungen an dieser Anbindung sind nicht gespeichert und gehen verloren.</Trans>
      </ConfirmDialog>
    </section>
  )
}
