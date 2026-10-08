// What the model sees (plan E2.2, S6): the layer profile for one account —
// metadata only, limited to what that account sees and the administrator
// released for the model — with its hash and size. The per-layer view stays
// on the layer page.
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { useState } from 'react'
import type { ModelProfile } from '../api/client'
import { useModelProfile, useUsers } from '../api/queries'
import { ErrorNotice, Loading } from '../components/ui'
import { formatNumber } from '../i18n/locale'
import { typeLabel } from './format'

type AttributeProfile = ModelProfile['layers'][number]['attributes'][number]

function domainText(a: AttributeProfile): string {
  if (a.range) {
    const [low, high] = a.range.map((v) => formatNumber(v))
    return t`${low} bis ${high}`
  }
  if (a.codes) {
    const count = Object.keys(a.codes).length
    return t`Codeliste (${count})`
  }
  return ''
}

export function ProfilePage() {
  const users = useUsers()
  const [account, setAccount] = useState('')
  const profile = useModelProfile(account)
  const data = profile.data
  const size = data ? formatNumber(data.size_chars) : ''
  const count = data ? formatNumber(data.layers.length) : ''

  return (
    <section aria-labelledby="profile-title" className="max-w-5xl">
      <h2 id="profile-title" className="mb-1 text-2xl">
        <Trans>Was das Modell sieht</Trans>
      </h2>
      <p className="text-muted mb-3 max-w-3xl text-sm">
        <Trans>
          Der Layer-Steckbrief, den ein Modell für ein Konto erhält: nur Metadaten, nur Layer, die
          das Konto sieht und die für das Modell freigegeben sind. Keine Objektzahlen, keine
          Ausdehnung, keine Werte aus den Daten ausser bestätigten Codelisten.
        </Trans>
      </p>
      <label className="mb-3 flex items-center gap-2 text-sm">
        <Trans>Konto</Trans>
        <select className="input" value={account} onChange={(e) => setAccount(e.target.value)}>
          <option value="">{t`– wählen –`}</option>
          {users.data?.map((u) => (
            <option key={u.username} value={u.username}>
              {u.username}
            </option>
          ))}
        </select>
      </label>
      <ErrorNotice error={users.error ?? profile.error} />
      {account && profile.isPending && <Loading />}
      {data && (
        <>
          <dl className="mb-3 grid max-w-2xl grid-cols-[10rem_1fr] gap-x-3 text-sm">
            <dt>
              <Trans>Layer</Trans>
            </dt>
            <dd>{count}</dd>
            <dt>
              <Trans>Grösse</Trans>
            </dt>
            <dd>{t`${size} Zeichen`}</dd>
            <dt>
              <Trans>Prüfsumme</Trans>
            </dt>
            <dd>
              <code className="text-xs break-all">{data.hash}</code>
            </dd>
          </dl>
          {data.layers.length === 0 && (
            <p className="text-muted text-sm">
              <Trans>Für dieses Konto kennt das Modell keinen Layer.</Trans>
            </p>
          )}
          {data.layers.map((layer) => (
            <section key={layer.name} aria-label={layer.title} className="card mb-3 p-3">
              <h3 className="text-lg">
                {layer.title} <code className="text-muted text-xs">{layer.name}</code>
              </h3>
              {layer.description && <p className="text-muted text-sm">{layer.description}</p>}
              <table className="data-table mt-2">
                <thead>
                  <tr>
                    <th>
                      <Trans>Feld</Trans>
                    </th>
                    <th>
                      <Trans>Bezeichnung</Trans>
                    </th>
                    <th>
                      <Trans>Typ</Trans>
                    </th>
                    <th>
                      <Trans>Einheit</Trans>
                    </th>
                    <th>
                      <Trans>Wertebereich</Trans>
                    </th>
                    <th>
                      <Trans>Bezug</Trans>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {layer.attributes.map((a) => (
                    <tr key={a.name}>
                      <td>
                        <code>{a.name}</code>
                      </td>
                      <td>{a.label}</td>
                      <td>{typeLabel(a.type as Parameters<typeof typeLabel>[0])}</td>
                      <td>{a.unit ?? ''}</td>
                      <td>{domainText(a)}</td>
                      <td>{a.references ? <code>{a.references}</code> : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
          <details className="text-sm">
            <summary className="cursor-pointer">
              <Trans>Als JSON</Trans>
            </summary>
            <pre className="mt-2 overflow-auto bg-neutral-200 p-2 text-xs">
              {JSON.stringify(
                { profile_version: data.profile_version, layers: data.layers },
                null,
                2,
              )}
            </pre>
          </details>
        </>
      )}
    </section>
  )
}
