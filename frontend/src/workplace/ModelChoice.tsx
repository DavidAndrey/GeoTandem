// Model support in the workplace header (plan E2.1, WP59): the active
// connection, an external one naming its host (F-9.4, C7), and the active
// level, visible at all times (F-6.1). The account chooses within the
// administrator's frame; the backend checks every choice.
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { ChevronDown } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { Link } from 'react-router'
import { useChooseLLM, useLLMOptions, useMe } from '../api/queries'
import { LocalityBadge } from '../components/LocalityBadge'

const item =
  'flex cursor-pointer items-start gap-2 px-3 py-1 text-sm outline-none data-[highlighted]:bg-neutral-200'

function Dot() {
  return (
    <DropdownMenu.ItemIndicator className="mt-1.5 size-2 rounded-full bg-[var(--color-accent)]" />
  )
}

export function ModelChoice() {
  const options = useLLMOptions()
  const choose = useChooseLLM()
  const me = useMe()
  const data = options.data
  if (!data) return null

  if (data.connections.length === 0)
    return (
      <span className="text-muted text-sm">
        <Trans>Keine Modellanbindung eingerichtet</Trans>
        {me.data?.role === 'admin' && (
          <>
            {' · '}
            <Link to="/admin/modelle" className="underline">
              <Trans>einrichten</Trans>
            </Link>
          </>
        )}
      </span>
    )

  const connection = data.connections.find((c) => c.id === data.active_connection_id)
  const level = data.levels.find((l) => l.id === data.active_level_id)
  const levelName = level?.name ?? ''
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        className="btn flex items-center gap-2 text-sm font-normal"
        aria-label={t`Modellunterstützung wählen`}
      >
        {connection && (
          <>
            <span>{connection.name}</span>
            <LocalityBadge locality={connection.locality} host={connection.host} />
          </>
        )}
        <span className="text-muted">·</span>
        <span>{t`Stufe: ${levelName}`}</span>
        <ChevronDown size={14} aria-hidden />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          className="card z-[1300] w-80 bg-neutral-100 py-1 shadow-[var(--shadow-md)]"
        >
          <DropdownMenu.Label className="label-caps px-3 pt-1">
            <Trans>Anbindung</Trans>
          </DropdownMenu.Label>
          <DropdownMenu.RadioGroup
            value={String(data.active_connection_id ?? '')}
            onValueChange={(id) => choose.mutate({ connection_id: Number(id) })}
          >
            {data.connections.map((c) => (
              <DropdownMenu.RadioItem key={c.id} value={String(c.id)} className={item}>
                <span className="w-2">
                  <Dot />
                </span>
                <span className="flex-1">
                  {c.name}
                  {c.is_default && (
                    <span className="text-muted text-xs">
                      {' '}
                      <Trans>(voreingestellt)</Trans>
                    </span>
                  )}
                  <span className="text-muted block font-mono text-xs">{c.model}</span>
                </span>
                <LocalityBadge locality={c.locality} host={c.host} />
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
          <DropdownMenu.Separator className="bg-divider my-1 h-px" />
          <DropdownMenu.Label className="label-caps px-3 pt-1">
            <Trans>Stufe der Modellunterstützung</Trans>
          </DropdownMenu.Label>
          <DropdownMenu.RadioGroup
            value={String(data.active_level_id)}
            onValueChange={(id) => choose.mutate({ level_id: Number(id) })}
          >
            {data.levels.map((l) => (
              <DropdownMenu.RadioItem key={l.id} value={String(l.id)} className={item}>
                <span className="w-2">
                  <Dot />
                </span>
                <span className="flex-1">
                  {l.name}
                  {!l.selectable && (
                    <span className="text-muted text-xs">
                      {' '}
                      <Trans>(nur Administratoren)</Trans>
                    </span>
                  )}
                  {l.description && (
                    <span className="text-muted block text-xs">{l.description}</span>
                  )}
                </span>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
