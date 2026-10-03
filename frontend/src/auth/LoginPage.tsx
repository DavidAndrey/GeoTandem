// Sign-in (design A2). No self-registration, no password e-mail.
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router'
import { api } from '../api/client'
import { useMe, useResetSession } from '../api/queries'
import { ErrorNotice } from '../components/ui'
import { AccessCard, Field } from './AccessCard'
import { safeTarget } from './rules'

export function LoginPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const me = useMe()
  const resetSession = useResetSession()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const target = safeTarget(params.get('ziel'))
  const login = useMutation({
    mutationFn: () => api.auth.login(username, password),
    onSuccess: async (account) => {
      await resetSession()
      navigate(account.must_change_password ? '/passwort' : target, { replace: true })
    },
  })

  if (me.data && !login.isPending && !login.isSuccess) return <Navigate to={target} replace />

  return (
    <AccessCard title="Anmelden">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          login.mutate()
        }}
      >
        <Field label="Benutzername">
          <input
            className="input"
            autoComplete="username"
            required
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </Field>
        <Field label="Passwort">
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <ErrorNotice error={login.error} />
        <button
          type="submit"
          className="btn btn-primary mt-2 w-full justify-center"
          disabled={login.isPending}
        >
          Anmelden
        </button>
        <p className="text-muted mt-4 text-xs">
          Kein Konto oder Passwort vergessen? Bitte an den Administrator wenden.
        </p>
      </form>
    </AccessCard>
  )
}
