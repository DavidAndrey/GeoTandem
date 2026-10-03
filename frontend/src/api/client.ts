// Typed access to the HTTP interface. Types come from the backend's OpenAPI
// description (`npm run gen:api`); never write them by hand (tech-stack 4.5).
import type { components } from './schema'

export type Schemas = components['schemas']
export type Health = Schemas['Health']
export type ApiError = Schemas['ErrorBody']
export type LayerInfo = Schemas['LayerInfo']
export type AdminLayerInfo = Schemas['AdminLayerInfo']
export type AttributeInfo = Schemas['AttributeInfo']
export type LayerUpdate = Schemas['LayerUpdate']
export type AttributeUpdate = Schemas['AttributeUpdate']
export type LayerProfile = Schemas['LayerProfile']
export type Preview = Schemas['Preview']
export type ReadOptions = Schemas['ReadOptions']
export type Upload = Schemas['Upload']
export type ImportDecisions = Schemas['ImportDecisions']
export type FieldDecision = Schemas['FieldDecision']
export type ImportRunInfo = Schemas['ImportRunInfo']
export type ImportRunSummary = Schemas['ImportRunSummary']
export type ImportStatus = ImportRunSummary['status']
export type Message = Schemas['Message']
export type QueryResult = Schemas['QueryResult']

export class ApiRequestError extends Error {
  readonly status: number
  readonly body: ApiError | undefined

  constructor(status: number, body: ApiError | undefined) {
    super(body?.message ?? `HTTP ${status}`)
    this.status = status
    this.body = body
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const isForm = init?.body instanceof FormData
  const response = await fetch(path, {
    ...init,
    headers: isForm ? init?.headers : { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as ApiError | undefined
    throw new ApiRequestError(response.status, body)
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  body: JSON.stringify(body),
})

const enc = encodeURIComponent

export const api = {
  health: () => request<Health>('/api/health'),
  layer: (name: string) => request<LayerInfo>(`/api/layers/${enc(name)}`),
  sampleRows: (layer: string, limit = 50) =>
    request<QueryResult>('/api/query', json('POST', { source: layer, output: 'table', limit })),

  admin: {
    layers: () => request<AdminLayerInfo[]>('/api/admin/layers'),
    updateLayer: (name: string, body: LayerUpdate) =>
      request<LayerInfo>(`/api/admin/layers/${enc(name)}`, json('PATCH', body)),
    updateAttribute: (layer: string, attribute: string, body: AttributeUpdate) =>
      request<AttributeInfo>(
        `/api/admin/layers/${enc(layer)}/attributes/${enc(attribute)}`,
        json('PATCH', body),
      ),
    deleteLayer: (name: string) =>
      request<undefined>(`/api/admin/layers/${enc(name)}`, { method: 'DELETE' }),
    profile: (name: string) =>
      request<LayerProfile | null>(`/api/admin/layers/${enc(name)}/profile`),

    upload: (file: File) => {
      const form = new FormData()
      form.append('file', file)
      return request<Upload>('/api/admin/imports', { method: 'POST', body: form })
    },
    repreview: (importId: string, options: ReadOptions) =>
      request<Preview>(`/api/admin/imports/${enc(importId)}/preview`, json('POST', options)),
    commit: (importId: string, decisions: ImportDecisions) =>
      request<ImportRunInfo>(`/api/admin/imports/${enc(importId)}/commit`, json('POST', decisions)),
    cancel: (importId: string) =>
      request<ImportRunInfo>(`/api/admin/imports/${enc(importId)}`, { method: 'DELETE' }),

    importLog: (filter: { status?: ImportStatus; layer?: string } = {}) => {
      const params = new URLSearchParams()
      if (filter.status) params.set('status', filter.status)
      if (filter.layer) params.set('layer', filter.layer)
      const query = params.size ? `?${params}` : ''
      return request<ImportRunSummary[]>(`/api/admin/import-log${query}`)
    },
    importRun: (id: number) => request<ImportRunInfo>(`/api/admin/import-log/${id}`),
  },
}
