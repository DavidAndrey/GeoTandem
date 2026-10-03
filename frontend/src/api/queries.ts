// Server state through TanStack Query (tech-stack 4.4): cached, invalidated
// after changes, never mirrored into component state.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type AttributeUpdate, type ImportStatus, type LayerUpdate } from './client'

export const keys = {
  health: ['health'] as const,
  layers: ['admin', 'layers'] as const,
  layer: (name: string) => ['layer', name] as const,
  profile: (name: string) => ['admin', 'profile', name] as const,
  rows: (name: string) => ['rows', name] as const,
  importLog: (filter: object) => ['admin', 'import-log', filter] as const,
  importRun: (id: number) => ['admin', 'import-run', id] as const,
}

export const useHealth = () => useQuery({ queryKey: keys.health, queryFn: api.health })

export const useAdminLayers = () => useQuery({ queryKey: keys.layers, queryFn: api.admin.layers })

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
