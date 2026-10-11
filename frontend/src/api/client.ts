// Typed access to the HTTP interface. Types come from the backend's OpenAPI
// description (`npm run gen:api`); never write them by hand (tech-stack 4.5).
import { errorText } from '../i18n/errors'
import type { components } from './schema'

export type Schemas = components['schemas']
export type SystemStatus = Schemas['SystemStatus']
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
export type Level = Schemas['Level']
export type OpClass = Schemas['OpClass']
export type CellMode = Schemas['CellMode']
export type ConnectionInfo = Schemas['ConnectionInfo']
export type ConnectionWrite = Schemas['ConnectionWrite']
export type ConnectionPatch = Schemas['ConnectionPatch']
export type ConnectionDraft = Schemas['ConnectionDraft']
export type CheckResult = Schemas['CheckResult']
export type CheckStep = Schemas['CheckStep']
export type Effort = NonNullable<ConnectionWrite['reasoning_effort']>
export type LLMOptions = Schemas['LLMOptions']
export type ProfilePreview = Schemas['ProfilePreview']
export type LLMChoice = Schemas['Choice']
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
// Modus B (plan E2.3-E2.6, frozen in WP62)
export type PromptRequest = Schemas['PromptRequest']
export type ModelAnswer = NonNullable<ModelActionView['answer']>
export type ModelActionView = Schemas['ModelActionView']
export type ModelActionSummary = Schemas['ModelActionSummary']
export type ModelActionPage = Schemas['ModelActionPage']
export type ActionStatus = ModelActionView['status']
export type Decision = NonNullable<ModelActionView['decision']>
export type Governance = Schemas['Governance']
export type StepView = Schemas['StepView']
export type ActionPreview = Schemas['ActionPreview']
export type Comparison = Schemas['Comparison']
export type CompareReason = NonNullable<Comparison['reason']>
export type ConditionChange = Schemas['ConditionChange']
export type FeatureRef = Schemas['FeatureRef']
export type KeyFigures = Schemas['KeyFigures']
export type ExecuteResponse = Schemas['ExecuteResponse']
export type ModelView = Schemas['ModelView']
export type StopReason = NonNullable<ModelActionView['stop_reason']>
export type PlanEdit = Schemas['PlanEdit']
export type StepEdit = Schemas['StepEdit']
export type StepStatus = StepView['status']
/** ``applied_by_hand`` has a server default (false) and goes only with ``proposal_only``. */
export type DecideRequest = Omit<Schemas['DecideRequest'], 'applied_by_hand'> &
  Partial<Pick<Schemas['DecideRequest'], 'applied_by_hand'>>
export type Assumption = Schemas['Assumption']
export type Approach = ModelActionView['approach']
/** The filters of the model log (design M16.1); ``from``/``to`` as ISO times. */
export interface ModelLogFilter {
  from?: string
  to?: string
  level_id?: number
  connection_id?: number
  approach?: Approach
  account?: string
}

/** A filter and a page as query parameters, only what is set. */
function logParams(filter: ModelLogFilter, page?: { offset: number; limit: number }): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries({ ...filter, ...page }))
    if (value !== undefined && value !== '') params.set(key, String(value))
  return params.size ? `?${params}` : ''
}
export type RejectReason = NonNullable<Schemas['RejectRequest']['reason']>
export type LevelOption = LLMOptions['levels'][number]

export class ApiRequestError extends Error {
  readonly status: number
  readonly body: ApiError | undefined

  constructor(status: number, body: ApiError | undefined) {
    // In the user's language from the code (plan E1.9, L6); the English stays in body.
    super(body?.code ? errorText(body.code, body.details, body.message) : `HTTP ${status}`)
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
  llm: {
    options: () => request<LLMOptions>('/api/llm/options'),
    choose: (choice: LLMChoice) => request<LLMOptions>('/api/llm/options', json('PUT', choice)),
  },
  auth: {
    setupStatus: () => request<SetupStatus>('/api/auth/setup'),
    setup: (body: {
      token: string
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
  // Modus B (plan section 6): a prompt answers 202 with the record ``thinking``;
  // the client polls the record until the model has answered (P7).
  model: {
    prompt: (body: PromptRequest) =>
      request<ModelActionView>('/api/model/prompt', json('POST', body)),
    action: (id: number) => request<ModelActionView>(`/api/model/actions/${id}`),
    decide: (id: number, body: DecideRequest) =>
      request<ModelActionView>(`/api/model/actions/${id}/decide`, json('POST', body)),
    abort: (id: number) =>
      request<ModelActionView>(`/api/model/actions/${id}/abort`, { method: 'POST' }),
    /** The account's own log entries, newest first (D4, design M16.3). */
    myActions: (offset = 0, limit = 50) =>
      request<ModelActionPage>(`/api/model/my-actions${logParams({}, { offset, limit })}`),
    // Enforcement (plan D2, WP70): the transitions of a record. ``execute`` takes
    // no body: the server runs the stored query, never one the client sends.
    /** Count and ids of the stored query, for the user only (P2). A POST: it
     * stamps ``previewed_at`` on the record (security review #39). */
    preview: (id: number) =>
      request<ActionPreview>(`/api/model/actions/${id}/preview`, { method: 'POST' }),
    approve: (id: number) =>
      request<ModelActionView>(`/api/model/actions/${id}/approve`, { method: 'POST' }),
    reject: (id: number, reason: RejectReason | null = null) =>
      request<ModelActionView>(`/api/model/actions/${id}/reject`, json('POST', { reason })),
    /** The one answer with rows (D2, P7). */
    execute: (id: number) =>
      request<ExecuteResponse>(`/api/model/actions/${id}/execute`, { method: 'POST' }),
    /** For the log: the client restores the analysis itself (D2). */
    undo: (id: number) =>
      request<ModelActionView>(`/api/model/actions/${id}/undo`, { method: 'POST' }),
    /** The analysis was changed by hand since this action: its undo is over (design rule 7). */
    touched: (id: number) =>
      request<ModelActionView>(`/api/model/actions/${id}/touched`, { method: 'POST' }),
    // The tool chain (plan P4, WP75): a plan is approved like a proposal, then run
    // in the background (202) and polled; its result is adopted, never executed.
    /** Change values or remove steps of a plan not yet started; never add one (design 17). */
    editPlan: (id: number, body: PlanEdit) =>
      request<ModelActionView>(`/api/model/actions/${id}/plan`, json('PATCH', body)),
    /** 202 with the record ``running``: the client polls it (P4). */
    run: (id: number) =>
      request<ModelActionView>(`/api/model/actions/${id}/run`, { method: 'POST' }),
    /** A ``done`` or ``limited`` chain's result becomes the analysis; with rows (D2). */
    adopt: (id: number) =>
      request<ExecuteResponse>(`/api/model/actions/${id}/adopt`, { method: 'POST' }),
    // The comparison (plan P7, WP76, design M10): the same prompt with the other
    // approach as a new record (``compare_of``) under the level as it is now.
    /** 202 with the repeat ``thinking``: polled like any prompt; it waits ``proposed``. */
    compare: (id: number) =>
      request<ModelActionView>(`/api/model/actions/${id}/compare`, { method: 'POST' }),
    /** Both sides once each has a result: stamps, the difference by feature id, the reason as data. */
    comparison: (id: number) => request<Comparison>(`/api/model/actions/${id}/comparison`),
  },
  sampleRows: (layer: string, limit = 50) =>
    request<QueryResult>('/api/query', json('POST', { source: layer, output: 'table', limit })),

  admin: {
    system: () => request<SystemStatus>('/api/admin/system'),
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
    levels: () => request<Schemas['LevelSet']>('/api/admin/levels'),
    saveLevels: (levels: Level[]) =>
      request<Schemas['LevelSet']>('/api/admin/levels', json('PUT', { levels })),
    modelProfile: (account: string) =>
      request<ProfilePreview>(`/api/admin/llm/profile?account=${enc(account)}`),
    connections: () => request<ConnectionInfo[]>('/api/admin/llm/connections'),
    createConnection: (body: ConnectionWrite) =>
      request<ConnectionInfo>('/api/admin/llm/connections', json('POST', body)),
    updateConnection: (id: number, body: ConnectionPatch) =>
      request<ConnectionInfo>(`/api/admin/llm/connections/${id}`, json('PATCH', body)),
    deleteConnection: (id: number) =>
      request<undefined>(`/api/admin/llm/connections/${id}`, { method: 'DELETE' }),
    testConnection: (id: number) =>
      request<CheckResult>(`/api/admin/llm/connections/${id}/test`, { method: 'POST' }),
    testDraft: (body: ConnectionDraft) =>
      request<CheckResult>('/api/admin/llm/connections/test', json('POST', body)),

    // The model log (plan WP73, design M16): list, key figures and CSV take the same filters.
    modelActions: (filter: ModelLogFilter, offset = 0, limit = 50) =>
      request<ModelActionPage>(`/api/admin/model-actions${logParams(filter, { offset, limit })}`),
    modelKeyFigures: (filter: ModelLogFilter) =>
      request<KeyFigures>(`/api/admin/model-actions/key-figures${logParams(filter)}`),
    modelAction: (id: number) => request<ModelActionView>(`/api/admin/model-actions/${id}`),
    /** A link, not a request: the browser downloads the file with the session cookie. */
    modelExportUrl: (filter: ModelLogFilter) =>
      `/api/admin/model-actions/export.csv${logParams(filter)}`,
  },
}
