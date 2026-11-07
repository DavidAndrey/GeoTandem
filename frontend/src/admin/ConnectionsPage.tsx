// Model connections (plan E2.1, C4–C8, C12): the list, the test of a saved
// connection and deleting one. Each is edited on its own page
// (ConnectionDetailPage, plan-connection-detail).
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { api, type CheckResult, type ConnectionInfo } from '../api/client'
import { useConnectionChange, useConnections } from '../api/queries'
import { LocalityBadge } from '../components/LocalityBadge'
import { ConfirmDialog, ErrorNotice, Loading, Menu, MenuItem } from '../components/ui'
import { errorText } from '../i18n/errors'
import { actionsFor } from '../i18n/phrases'
import { CheckSteps, LastRun, LastTest } from './connectionParts'
import { detailPath, NEW } from './connectionPaths'

const deleteTitle = (name: string) => t`Anbindung „${name}" löschen?`
const testTitle = (name: string) => t`Verbindungstest „${name}"`

export function ConnectionsPage() {
  const connections = useConnections()
  const navigate = useNavigate()
  const [deleting, setDeleting] = useState<ConnectionInfo>()
  const [tested, setTested] = useState<{ name: string; result: CheckResult }>()
  const remove = useConnectionChange(api.admin.deleteConnection)
  const test = useConnectionChange((c: ConnectionInfo) =>
    api.admin.testConnection(c.id).then((result) => setTested({ name: c.name, result })),
  )

  return (
    <section aria-labelledby="connections-title" className="max-w-5xl">
      <div className="mb-1 flex items-center gap-3">
        <h2 id="connections-title" className="text-2xl">
          <Trans>Modellanbindungen</Trans>
        </h2>
        <Link to={NEW} className="btn btn-primary ml-auto">
          <Plus size={14} aria-hidden /> <Trans>Anbindung</Trans>
        </Link>
      </div>
      <p className="text-muted mb-3 max-w-3xl text-sm">
        <Trans>
          Modelle hinter einer OpenAI-kompatiblen Schnittstelle (Ollama, vLLM, llama.cpp, Cloud).
          Anwender wählen unter den freigegebenen; eine nicht freigegebene nutzt niemand, auch kein
          Administrator.
        </Trans>
      </p>
      {connections.isPending && <Loading />}
      <ErrorNotice error={connections.error ?? test.error} />
      {test.isPending && <Loading />}
      {tested && <CheckSteps result={tested.result} title={testTitle(tested.name)} />}
      {connections.data?.length === 0 && (
        <p className="text-muted text-sm">
          <Trans>
            Noch keine Anbindung. Ohne sie steht nur die klassische Bedienung (Modus A) zur
            Verfügung.
          </Trans>
        </p>
      )}
      {!!connections.data?.length && (
        <table className="data-table">
          <thead>
            <tr>
              <th>
                <Trans>Name</Trans>
              </th>
              <th>
                <Trans>Modell</Trans>
              </th>
              <th>
                <Trans>Art</Trans>
              </th>
              <th>
                <Trans>Für Anwender</Trans>
              </th>
              <th>
                <Trans>Dateninhalte</Trans>
              </th>
              <th>
                <Trans>Letzter Test</Trans>
              </th>
              <th>
                <Trans>Zuletzt bewertet</Trans>
              </th>
              <th>
                <span className="sr-only">
                  <Trans>Aktionen</Trans>
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {connections.data.map((c) => (
              <tr key={c.id}>
                <td>
                  <Link
                    to={detailPath(c.id)}
                    className="hover:text-accent-700 underline-offset-2 hover:underline"
                  >
                    {c.name}
                  </Link>
                  {c.is_default && (
                    <span className="chip ml-2">
                      <Trans>voreingestellt</Trans>
                    </span>
                  )}
                  {c.credentials_unreadable && (
                    <div className="text-danger text-xs">{errorText('credentials_unreadable')}</div>
                  )}
                </td>
                <td className="font-mono text-xs">{c.model}</td>
                <td>
                  <LocalityBadge locality={c.locality} host={c.host} />
                </td>
                <td>{c.enabled ? t`freigegeben` : t`nicht freigegeben`}</td>
                <td>{c.may_receive_data ? t`erlaubt` : t`nur Metadaten`}</td>
                <td>
                  <LastTest connection={c} />
                </td>
                <td>
                  <LastRun connection={c} />
                </td>
                <td className="text-right">
                  <Menu label={actionsFor(c.name)}>
                    <MenuItem onSelect={() => navigate(detailPath(c.id))}>
                      <Trans>Bearbeiten</Trans>
                    </MenuItem>
                    <MenuItem onSelect={() => test.mutate(c)}>
                      <Trans>Verbindung testen</Trans>
                    </MenuItem>
                    <MenuItem danger onSelect={() => setDeleting(c)}>
                      <Trans>Löschen</Trans>
                    </MenuItem>
                  </Menu>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {deleting && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setDeleting(undefined)}
          title={deleteTitle(deleting.name)}
          confirm={t`Löschen`}
          busy={remove.isPending}
          onConfirm={() => remove.mutate(deleting.id, { onSuccess: () => setDeleting(undefined) })}
        >
          <p>
            <Trans>
              Wer sie gewählt hatte, arbeitet mit der voreingestellten Anbindung weiter.
            </Trans>
          </p>
          <ErrorNotice error={remove.error} />
        </ConfirmDialog>
      )}
    </section>
  )
}
