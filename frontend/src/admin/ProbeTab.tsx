// «Verständnis» on the layer page (plan-attribute-metadata C, Q6): what a model
// reads from the layer's profile, beside what is curated. The administrator
// reads where they part; nothing is graded and nothing is kept.
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { useState } from 'react'
import type { AttributeInfo, AttributeReading, LayerInfo, ProbeResult } from '../api/client'
import { useLLMOptions, useProbeLayer } from '../api/queries'
import { ErrorNotice, Loading } from '../components/ui'
import { formatCodes } from './codes'

export function ProbeTab({ layer }: { layer: LayerInfo }) {
  const options = useLLMOptions()
  const probe = useProbeLayer(layer.name)
  const [chosen, setChosen] = useState<number | null>(null)

  if (!layer.for_model) {
    return (
      <p className="text-muted max-w-3xl text-sm">
        <Trans>
          Dieser Layer ist für das Modell nicht sichtbar; es gibt keinen Steckbrief zu prüfen.
        </Trans>
      </p>
    )
  }
  if (options.isPending) return <Loading />
  if (!options.data) return <ErrorNotice error={options.error} />
  const connections = options.data.connections
  const selected = chosen ?? options.data.active_connection_id
  const external = connections.find((c) => c.id === selected)?.locality === 'external'

  return (
    <div className="flex max-w-6xl flex-col gap-4">
      <p className="text-muted max-w-3xl text-sm">
        <Trans>
          Das Modell bekommt nur den Steckbrief dieses Layers, so wie bei einer Abfrage, und sagt je
          Feld, was es darunter versteht. Lesen Sie, wo es von den hinterlegten Angaben abweicht.
          Nichts wird bewertet oder gespeichert; die Anfrage zählt zum Tageslimit der Verbindung.
        </Trans>
      </p>
      {connections.length === 0 ? (
        <p className="text-sm">
          <Trans>Keine Modellverbindung ist eingeschaltet.</Trans>
        </p>
      ) : (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            probe.mutate(selected)
          }}
        >
          <label className="flex flex-col gap-1">
            <span className="label-caps">
              <Trans>Verbindung</Trans>
            </span>
            <select
              className="input"
              value={selected ?? ''}
              onChange={(e) => setChosen(Number(e.target.value))}
            >
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} · {c.model}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn btn-primary" disabled={probe.isPending}>
            <Trans>Verständnis prüfen</Trans>
          </button>
          {probe.isPending && (
            <span className="text-muted text-sm" role="status">
              <Trans>Das Modell liest den Steckbrief …</Trans>
            </span>
          )}
          {external && (
            <span className="text-muted basis-full text-sm">
              <Trans>
                Externe Verbindung: Es geht nur der Steckbrief hinaus, keine Inhalte der Daten.
              </Trans>
            </span>
          )}
        </form>
      )}
      <ErrorNotice error={probe.error} />
      {probe.data && !probe.isPending && <Readings layer={layer} result={probe.data} />}
    </div>
  )
}

function Readings({ layer, result }: { layer: LayerInfo; result: ProbeResult }) {
  const curated = new Map(layer.attributes.map((a) => [a.name, a]))
  return (
    <section aria-label={t`Was das Modell versteht`} className="flex flex-col gap-3">
      <dl className="grid max-w-4xl grid-cols-[10rem_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="label-caps">
          <Trans>Layer, hinterlegt</Trans>
        </dt>
        <dd>{layer.description || <Empty />}</dd>
        <dt className="label-caps">
          <Trans>Layer, gelesen</Trans>
        </dt>
        <dd>{result.meaning || <Empty />}</dd>
      </dl>
      <table className="data-table">
        <thead>
          <tr>
            <th>
              <Trans>Feld</Trans>
            </th>
            <th>
              <Trans>Hinterlegt</Trans>
            </th>
            <th>
              <Trans>Bedeutung, gelesen</Trans>
            </th>
            <th>
              <Trans>Einheit, gelesen</Trans>
            </th>
            <th>
              <Trans>Werte, gelesen</Trans>
            </th>
            <th>
              <Trans>Kennung</Trans>
            </th>
          </tr>
        </thead>
        <tbody>
          {result.attributes.map((reading) => (
            <ReadingRow key={reading.name} reading={reading} curated={curated.get(reading.name)} />
          ))}
        </tbody>
      </table>
      {result.unknown.length > 0 && (
        <p className="text-sm">
          <Trans>Das Modell nannte Felder, die der Steckbrief nicht hat:</Trans>{' '}
          {result.unknown.map((name, i) => (
            <span key={name}>
              {i > 0 && ', '}
              <code>{name}</code>
            </span>
          ))}
        </p>
      )}
      <Footer result={result} />
    </section>
  )
}

function Footer({ result }: { result: ProbeResult }) {
  const seconds = (result.latency_ms / 1000).toFixed(1)
  const sent = result.prompt_tokens
  const received = result.completion_tokens ?? 0
  return (
    <p className="text-muted text-xs">
      {result.connection.name} · {result.connection.model} · <Trans>{seconds} s</Trans>
      {sent != null && (
        <>
          {' · '}
          <Trans>
            {sent} + {received} Tokens
          </Trans>
        </>
      )}
    </p>
  )
}

function ReadingRow({
  reading,
  curated,
}: {
  reading: AttributeReading
  curated: AttributeInfo | undefined
}) {
  const codes = curated?.value_domain_confirmed
    ? formatCodes(curated.value_domain?.codes as Record<string, string> | undefined)
    : ''
  return (
    <tr className="align-top">
      <td>
        <code>{reading.name}</code>
      </td>
      <td className="text-sm">
        <div>{curated?.label || <Empty />}</div>
        {curated?.unit && <div className="text-muted">{curated.unit}</div>}
        {curated?.description && <div className="text-muted">{curated.description}</div>}
        {codes && <div className="text-muted whitespace-pre-line">{codes}</div>}
      </td>
      {reading.answered ? (
        <>
          <td className="text-sm">{reading.meaning || <Empty />}</td>
          <td className="text-sm">{reading.unit || <Empty />}</td>
          <td className="text-sm">{reading.values || <Empty />}</td>
          <td className="text-sm">
            {reading.identifier ? <Trans>ja</Trans> : <Trans>nein</Trans>}
          </td>
        </>
      ) : (
        <td colSpan={4} className="text-muted text-sm">
          <Trans>Das Modell hat zu diesem Feld nichts gesagt.</Trans>
        </td>
      )}
    </tr>
  )
}

function Empty() {
  return <span className="text-muted">–</span>
}
