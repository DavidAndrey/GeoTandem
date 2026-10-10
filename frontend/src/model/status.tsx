// The status label of Modus B (design E2 "Statussprache"): line style and text,
// never a colour of its own; the words and styles are in statusKey.ts.
import { Check, CircleHelp } from 'lucide-react'
import { lineStyle, statusText, type LineStyle, type StatusKey } from './statusKey'

const LABEL: Record<LineStyle, string> = {
  dashed: 'border-dashed border-accent text-accent-700',
  applied: 'border-accent text-accent-700',
  void: 'border-neutral-400 text-muted line-through',
  message: 'border-ink text-ink',
}

/** Announced at once (design "Barrierefreiheit": Fehler und Abweisung). */
const ALERT: readonly StatusKey[] = ['error', 'refused']

/**
 * A status as a small label in its line style. ``live`` makes it a live region
 * for the place where a status changes (design "Barrierefreiheit"):
 * ``role="alert"`` for an error or a refusal, ``role="status"`` otherwise; lists
 * of older answers leave it off.
 */
export function StatusLabel({
  status,
  detail,
  live,
}: {
  status: StatusKey
  /** Plain text after the label, e.g. the time "14:06". */
  detail?: string
  live?: boolean
}) {
  const style = lineStyle(status)
  const text = statusText(status)
  return (
    <span
      role={live ? (ALERT.includes(status) ? 'alert' : 'status') : undefined}
      data-status={status}
      data-line={style}
      className={`inline-flex items-center gap-1 rounded-full border px-2 text-xs ${LABEL[style]}`}
    >
      {style === 'applied' && <Check size={11} aria-hidden />}
      {status === 'clarification' && <CircleHelp size={11} aria-hidden />}
      {/* Struck through by style only: <del> would be read as "gelöscht". */}
      <span>{text}</span>
      {detail && <span className="tabular-nums">{detail}</span>}
    </span>
  )
}
