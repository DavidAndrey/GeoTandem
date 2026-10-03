// The small symbol before a layer's name: dot, line or square in its colour.
export function Swatch({
  kind,
  color,
}: {
  kind: 'point' | 'line' | 'area' | 'table'
  color: string
}) {
  if (kind === 'point')
    return (
      <span
        aria-hidden
        className="inline-block size-2.5 rounded-full"
        style={{ background: color }}
      />
    )
  if (kind === 'line')
    return <span aria-hidden className="inline-block h-0.5 w-3" style={{ background: color }} />
  if (kind === 'table')
    return <span aria-hidden className="inline-block size-2.5 border border-neutral-500" />
  return (
    <span
      aria-hidden
      className="inline-block size-2.5 border"
      style={{ borderColor: color, background: `${color}55` }}
    />
  )
}
