// The connection select of a metadata call (plan-attribute-metadata C, D); its
// state is `useConnectionChoice` (useConnectionChoice.ts).
import { Trans } from '@lingui/react/macro'
import type { LLMOptions } from '../api/client'

export function ConnectionSelect({
  connections,
  selected,
  onChange,
}: {
  connections: LLMOptions['connections']
  selected: number | null
  onChange: (id: number) => void
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="label-caps">
        <Trans>Verbindung</Trans>
      </span>
      <select
        className="input"
        value={selected ?? ''}
        onChange={(e) => onChange(Number(e.target.value))}
      >
        {connections.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name} · {c.model}
          </option>
        ))}
      </select>
    </label>
  )
}

export function ExternalNote() {
  return (
    <span className="text-muted basis-full text-sm">
      <Trans>Externe Verbindung: Es geht nur der Steckbrief hinaus, keine Inhalte der Daten.</Trans>
    </span>
  )
}

export function NoConnection() {
  return (
    <p className="text-sm">
      <Trans>Keine Modellverbindung ist eingeschaltet.</Trans>
    </p>
  )
}
