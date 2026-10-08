// Local or external model connection (plan E2.1, C5, C7). An external one
// names its host wherever it is chosen or active (F-9.4).
import { t } from '@lingui/core/macro'
import { Globe, HardDrive } from 'lucide-react'

export function LocalityBadge({
  locality,
  host,
}: {
  locality: 'local' | 'external'
  host: string
}) {
  if (locality === 'local')
    return (
      <span className="chip" title={t`Lokal: ${host}`}>
        <HardDrive size={12} aria-hidden /> {t`lokal`}
      </span>
    )
  return (
    <span className="chip chip-active" title={t`Extern: Anfragen gehen an ${host}`}>
      <Globe size={12} aria-hidden /> {t`extern · ${host}`}
    </span>
  )
}
