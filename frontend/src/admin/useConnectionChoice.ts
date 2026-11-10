// The connection a metadata call asks (plan-attribute-metadata C, D; Q9): any
// enabled one, the account's active one preset.
import { useState } from 'react'
import { useLLMOptions } from '../api/queries'

export function useConnectionChoice() {
  const options = useLLMOptions()
  const [chosen, setChosen] = useState<number | null>(null)
  const connections = options.data?.connections ?? []
  const selected = chosen ?? options.data?.active_connection_id ?? null
  const external = connections.find((c) => c.id === selected)?.locality === 'external'
  return { options, connections, selected, setChosen, external }
}
