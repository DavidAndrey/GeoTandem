// Typed access to the HTTP interface. Types come from the backend's OpenAPI
// description (`npm run gen:api`); never write them by hand (tech-stack 4.5).
import type { components } from './schema'

export type Schemas = components['schemas']
export type Health = Schemas['Health']
export type ApiError = Schemas['ErrorBody']

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
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as ApiError | undefined
    throw new ApiRequestError(response.status, body)
  }
  return (await response.json()) as T
}

export const api = {
  health: () => request<Health>('/api/health'),
}
