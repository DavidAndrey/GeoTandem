// "+ Layer" (design B11): only layers this account may see; table layers are
// join sources, not map layers; layers already in use are greyed out.
import { Plus } from 'lucide-react'
import { Popover } from 'radix-ui'
import { useState } from 'react'
import { Link } from 'react-router'
import { useAnalysis } from '../analysis/store'
import { useLayers, useMe } from '../api/queries'
import { ErrorNotice, Loading } from '../components/ui'

export function AddLayers() {
  const catalog = useLayers()
  const me = useMe()
  const used = useAnalysis((s) => s.layers)
  const addLayer = useAnalysis((s) => s.addLayer)
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [chosen, setChosen] = useState<string[]>([])
  const needle = search.trim().toLowerCase()
  const inUse = new Set(used.map((l) => (l.source.kind === 'catalog' ? l.source.layer : '')))
  const shown = (catalog.data ?? []).filter((l) =>
    `${l.title} ${l.name} ${l.description}`.toLowerCase().includes(needle),
  )

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setChosen([])
      }}
    >
      <Popover.Trigger className="text-accent-700 flex items-center gap-1 text-sm">
        <Plus size={13} aria-hidden /> Layer
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={4}
          className="card z-[1100] w-72 p-3 shadow-[var(--shadow-md)]"
          aria-label="Layer hinzufügen"
        >
          <input
            type="search"
            className="input mb-2 w-full"
            placeholder="Layer suchen"
            aria-label="Layer suchen"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {catalog.isPending && <Loading />}
          <ErrorNotice error={catalog.error} />
          <ul className="max-h-64 overflow-auto text-sm">
            {shown.map((layer) => {
              const disabled = inUse.has(layer.name) || layer.kind === 'table'
              return (
                <li key={layer.name}>
                  <label
                    className={`flex items-center gap-2 py-0.5 ${disabled ? 'opacity-45' : ''}`}
                  >
                    <input
                      type="checkbox"
                      disabled={disabled}
                      checked={chosen.includes(layer.name) || inUse.has(layer.name)}
                      onChange={(e) =>
                        setChosen(
                          e.target.checked
                            ? [...chosen, layer.name]
                            : chosen.filter((n) => n !== layer.name),
                        )
                      }
                    />
                    <span className="flex-1">{layer.title}</span>
                    {layer.kind === 'table' && <span className="text-xs">nur für Join</span>}
                  </label>
                </li>
              )
            })}
            {catalog.data && shown.length === 0 && (
              <li className="text-muted py-2">
                {catalog.data.length === 0 ? 'Keine Layer freigegeben.' : 'Kein Layer passt.'}
              </li>
            )}
          </ul>
          <div className="mt-3 flex items-center gap-2">
            {me.data?.role === 'admin' && (
              <Link to="/admin/daten/import" className="text-accent-700 text-xs">
                Neue Daten importieren
              </Link>
            )}
            <button
              type="button"
              className="btn btn-primary ml-auto"
              disabled={chosen.length === 0}
              onClick={() => {
                // Added in reverse so the first chosen ends on top; it also becomes
                // the result layer if there is none yet.
                const first = chosen[0]
                const noResult = useAnalysis.getState().result === null
                ;[...chosen].reverse().forEach((name) => addLayer(name, noResult && name === first))
                setOpen(false)
              }}
            >
              Hinzufügen
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
