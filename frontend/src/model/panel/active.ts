// The connection and level a prompt goes to now (header M7, status line M1);
// the server resolves both again for every request (plan WP65).
import { useLLMOptions } from '../../api/queries'

export function useActiveModel() {
  const options = useLLMOptions()
  const data = options.data
  const connection = data?.connections.find((c) => c.id === data.active_connection_id) ?? null
  const level = data?.levels.find((l) => l.id === data.active_level_id) ?? null
  return { loading: options.isPending, connection, level }
}
