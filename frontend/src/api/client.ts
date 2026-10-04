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
export type Account = Schemas['Account']
export type Role = Account['role']
export type SetupStatus = Schemas['SetupStatus']
export type StartPassword = Schemas['StartPassword']
export type AccountUpdate = Schemas['AccountUpdate']
export type VisibilityRow = Schemas['VisibilityRow']
export type MapConfig = Schemas['MapConfig']
export type QueryObject = Schemas['QueryObject-Input']
export type SessionSummary = Schemas['SessionSummary']
export type SessionDetail = Schemas['SessionDetail']
export type SessionWrite = Schemas['SessionWrite']
export type SessionStamp = Schemas['SessionStamp']
export type SessionCheck = Schemas['Check']
export type SavedQuerySummary = Schemas['SavedQuerySummary']
export type SavedQueryDetail = Schemas['SavedQueryDetail']
export type SavedQueryWrite = Schemas['SavedQueryWrite']

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

  auth: {
    setupStatus: () => request<SetupStatus>('/api/auth/setup'),
    setup: (body: {
      username: string
      display_name: string
      password: string
      load_sample: boolean
    }) => request<Account>('/api/auth/setup', json('POST', body)),
    login: (username: string, password: string) =>
      request<Account>('/api/auth/login', json('POST', { username, password })),
    logout: () => request<undefined>('/api/auth/logout', { method: 'POST' }),
    me: () => request<Account>('/api/auth/me'),
    changePassword: (current: string, next: string) =>
      request<undefined>('/api/auth/password', json('POST', { current, new: next })),
  },
  layers: () => request<LayerInfo[]>('/api/layers'),
  layer: (name: string) => request<LayerInfo>(`/api/layers/${enc(name)}`),
  query: (query: QueryObject) => request<QueryResult>('/api/query', json('POST', query)),
  count: (queries: QueryObject[]) =>
    request<Schemas['Counts']>('/api/query/count', json('POST', { queries })),
  ids: (query: QueryObject) => request<Schemas['Ids']>('/api/query/ids', json('POST', query)),
  mapConfig: () => request<MapConfig>('/api/config/map'),
  sessions: {
    list: () => request<SessionSummary[]>('/api/sessions'),
    last: () => request<SessionDetail | null>('/api/sessions/last'),
    get: (id: string) => request<SessionDetail>(`/api/sessions/${enc(id)}`),
    create: (body: SessionWrite) => request<SessionDetail>('/api/sessions', json('POST', body)),
    save: (id: string, body: SessionWrite) =>
      request<SessionDetail>(`/api/sessions/${enc(id)}`, json('PUT', body)),
    rename: (id: string, body: { name?: string; note?: string }) =>
      request<SessionSummary>(`/api/sessions/${enc(id)}`, json('PATCH', body)),
    duplicate: (id: string) =>
      request<SessionSummary>(`/api/sessions/${enc(id)}/duplicate`, { method: 'POST' }),
    remove: (id: string) => request<undefined>(`/api/sessions/${enc(id)}`, { method: 'DELETE' }),
    check: (id: string, rebuilt: QueryObject | null) =>
      request<SessionCheck>(
        `/api/sessions/${enc(id)}/check`,
        json('POST', { rebuilt, has_result: rebuilt !== null }),
      ),
  },
  queries: {
    list: () => request<SavedQuerySummary[]>('/api/queries'),
    get: (id: string) => request<SavedQueryDetail>(`/api/queries/${enc(id)}`),
    create: (body: SavedQueryWrite) =>
      request<SavedQueryDetail>('/api/queries', json('POST', body)),
    save: (id: string, body: SavedQueryWrite) =>
      request<SavedQueryDetail>(`/api/queries/${enc(id)}`, json('PUT', body)),
    patch: (id: string, body: { name?: string; shared?: boolean }) =>
      request<SavedQuerySummary>(`/api/queries/${enc(id)}`, json('PATCH', body)),
    duplicate: (id: string) =>
      request<SavedQuerySummary>(`/api/queries/${enc(id)}/duplicate`, { method: 'POST' }),
    usage: (id: string) => request<Schemas['Usage']>(`/api/queries/${enc(id)}/usage`),
    remove: (id: string) => request<undefined>(`/api/queries/${enc(id)}`, { method: 'DELETE' }),
  },
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

    users: () => request<Account[]>('/api/admin/users'),
    createUser: (body: { username: string; display_name: string; role: Role }) =>
      request<StartPassword>('/api/admin/users', json('POST', body)),
    updateUser: (username: string, body: AccountUpdate) =>
      request<Account>(`/api/admin/users/${enc(username)}`, json('PATCH', body)),
    resetPassword: (username: string) =>
      request<StartPassword>(`/api/admin/users/${enc(username)}/reset-password`, {
        method: 'POST',
      }),
    deleteUser: (username: string) =>
      request<undefined>(`/api/admin/users/${enc(username)}`, { method: 'DELETE' }),

    visibility: () => request<VisibilityRow[]>('/api/admin/visibility'),
    visibilityDefault: () => request<Schemas['VisibilityDefault']>('/api/admin/visibility/default'),
    setVisibilityDefault: (visible: boolean) =>
      request<Schemas['VisibilityDefault']>(
        '/api/admin/visibility/default',
        json('PUT', { new_layers_visible: visible }),
      ),
    duplicateLayer: (name: string, body: { name?: string; title?: string }) =>
      request<LayerInfo>(`/api/admin/layers/${enc(name)}/duplicate`, json('POST', body)),
    setVisibility: (layer: string, visible: boolean) =>
      request<VisibilityRow[]>(
        '/api/admin/visibility',
        json('PUT', { layer, role: 'user', visible }),
      ),
  },
}
