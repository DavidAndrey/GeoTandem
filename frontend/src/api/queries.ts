// Server state through TanStack Query (tech-stack 4.4): cached, invalidated
// after changes, never mirrored into component state.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  api,
  ApiRequestError,
  type AccountUpdate,
  type AttributeUpdate,
  type ImportStatus,
  type LayerUpdate,
  type VisibilityRow,
} from './client'

export const keys = {
  layers: ['admin', 'layers'] as const,
  // Under 'one': a layer may be named "list" (['layer', 'list'] is the catalog).
  layerList: ['layer', 'list'] as const,
  layer: (name: string) => ['layer', 'one', name] as const,
  profile: (name: string) => ['admin', 'profile', name] as const,
  rows: (name: string) => ['rows', name] as const,
  importLog: (filter: object) => ['admin', 'import-log', filter] as const,
  importRun: (id: number) => ['admin', 'import-run', id] as const,
  me: ['auth', 'me'] as const,
  setup: ['auth', 'setup'] as const,
  users: ['admin', 'users'] as const,
  visibility: ['admin', 'visibility'] as const,
  visibilityDefault: ['admin', 'visibility', 'default'] as const,
  levels: ['admin', 'levels'] as const,
  connections: ['admin', 'llm', 'connections'] as const,
  llmOptions: ['llm', 'options'] as const,
  modelProfile: (account: string) => ['admin', 'model-profile', account] as const,
}

/** The signed-in account, or ``null`` when nobody is signed in. */
export const useMe = () =>
  useQuery({
    queryKey: keys.me,
    queryFn: async () => {
      try {
        return await api.auth.me()
      } catch (error) {
        if (error instanceof ApiRequestError && error.status === 401) return null
        throw error
      }
    },
    staleTime: 60_000,
  })

export const useSetupStatus = () =>
  useQuery({ queryKey: keys.setup, queryFn: api.auth.setupStatus })

/** After sign-in, sign-out or a password change everything cached may be stale. */
export function useResetSession() {
  const client = useQueryClient()
  return () => client.resetQueries()
}

export const useUsers = () => useQuery({ queryKey: keys.users, queryFn: api.admin.users })

export function useUpdateUser() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ username, body }: { username: string; body: AccountUpdate }) =>
      api.admin.updateUser(username, body),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.users }),
  })
}

export const useVisibility = () =>
  useQuery({ queryKey: keys.visibility, queryFn: api.admin.visibility })

/** Shown at once, rolled back if the server refuses. */
export function useSetVisibility() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ layer, visible }: { layer: string; visible: boolean }) =>
      api.admin.setVisibility(layer, visible),
    onMutate: async ({ layer, visible }) => {
      await client.cancelQueries({ queryKey: keys.visibility })
      const before = client.getQueryData<VisibilityRow[]>(keys.visibility)
      client.setQueryData<VisibilityRow[]>(keys.visibility, (rows) =>
        rows?.map((r) => (r.layer === layer ? { ...r, roles: { ...r.roles, user: visible } } : r)),
      )
      return { before }
    },
    onError: (_error, _vars, context) => client.setQueryData(keys.visibility, context?.before),
    onSuccess: (rows) => client.setQueryData(keys.visibility, rows),
  })
}

export const useAdminLayers = () => useQuery({ queryKey: keys.layers, queryFn: api.admin.layers })

export const useMapConfig = () =>
  useQuery({ queryKey: ['map-config'], queryFn: api.mapConfig, staleTime: Infinity })

/** The layers the signed-in account may see (F-2.7). */
const layerList = { queryKey: keys.layerList, queryFn: api.layers }

export const useLayers = () => useQuery(layerList)

/** The catalog, waiting for it if it has not loaded yet — for actions that need it now. */
export function useEnsureLayers() {
  const client = useQueryClient()
  return () => client.ensureQueryData(layerList)
}

/** An empty name means "no layer" and fetches nothing. */
export const useLayer = (name: string) =>
  useQuery({ queryKey: keys.layer(name), queryFn: () => api.layer(name), enabled: name !== '' })

export const useProfile = (name: string) =>
  useQuery({ queryKey: keys.profile(name), queryFn: () => api.admin.profile(name) })

export const useSampleRows = (name: string) =>
  useQuery({ queryKey: keys.rows(name), queryFn: () => api.sampleRows(name) })

export const useImportLog = (filter: { status?: ImportStatus; layer?: string }) =>
  useQuery({ queryKey: keys.importLog(filter), queryFn: () => api.admin.importLog(filter) })

export const useImportRun = (id: number) =>
  useQuery({ queryKey: keys.importRun(id), queryFn: () => api.admin.importRun(id) })

/** Anything that changes layers invalidates every layer-derived view. */
export function useInvalidateLayers() {
  const client = useQueryClient()
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ['admin'] }),
      client.invalidateQueries({ queryKey: ['layer'] }),
      client.invalidateQueries({ queryKey: ['rows'] }),
    ])
}

export function useUpdateLayer(name: string) {
  const invalidate = useInvalidateLayers()
  return useMutation({
    mutationFn: (body: LayerUpdate) => api.admin.updateLayer(name, body),
    onSuccess: invalidate,
  })
}

export function useUpdateAttribute(layer: string) {
  const invalidate = useInvalidateLayers()
  return useMutation({
    mutationFn: ({ attribute, body }: { attribute: string; body: AttributeUpdate }) =>
      api.admin.updateAttribute(layer, attribute, body),
    onSuccess: invalidate,
  })
}

export function useDeleteLayer() {
  const invalidate = useInvalidateLayers()
  return useMutation({ mutationFn: api.admin.deleteLayer, onSuccess: invalidate })
}

/** New layers visible for users at once, or after release (design D10). */
export const useVisibilityDefault = () =>
  useQuery({ queryKey: keys.visibilityDefault, queryFn: api.admin.visibilityDefault })

export function useSetVisibilityDefault() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: api.admin.setVisibilityDefault,
    onSuccess: (data) => client.setQueryData(keys.visibilityDefault, data),
  })
}

/** A copy of a layer (design D2); the catalog and the visibility list show it at once. */
export function useDuplicateLayer() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ layer, name, title }: { layer: string; name?: string; title?: string }) =>
      api.admin.duplicateLayer(layer, { name, title }),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: keys.layers }),
        client.invalidateQueries({ queryKey: keys.visibility }),
        client.invalidateQueries({ queryKey: keys.layerList }),
      ]),
  })
}

/** The levels of model support (plan E2.0), edited and saved as a whole set. */
export const useLevels = () => useQuery({ queryKey: keys.levels, queryFn: api.admin.levels })

export function useSaveLevels() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: api.admin.saveLevels,
    onSuccess: (data) => {
      client.setQueryData(keys.levels, data)
      return client.invalidateQueries({ queryKey: keys.llmOptions })
    },
  })
}

/** Model connections (plan E2.1); every change refreshes the list. */
export const useConnections = () =>
  useQuery({ queryKey: keys.connections, queryFn: api.admin.connections })

export function useConnectionChange<T, R>(change: (args: T) => Promise<R>) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: change,
    // The account's options show enabled connections: they change too.
    onSuccess: () =>
      client
        .invalidateQueries({ queryKey: keys.connections })
        .then(() => client.invalidateQueries({ queryKey: keys.llmOptions })),
  })
}

/** What the account may choose for model support, and its choice (plan E2.1, C14). */
export const useLLMOptions = () => useQuery({ queryKey: keys.llmOptions, queryFn: api.llm.options })

export function useChooseLLM() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: api.llm.choose,
    onSuccess: (data) => client.setQueryData(keys.llmOptions, data),
  })
}

/** The layer profile a model would get for an account (plan E2.2, S6). */
export const useModelProfile = (account: string) =>
  useQuery({
    queryKey: keys.modelProfile(account),
    queryFn: () => api.admin.modelProfile(account),
    enabled: account !== '',
  })
