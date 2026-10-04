// Route guards (E1.4). They decide what to show; the backend decides what is
// allowed (F-3.1) — a guard that is bypassed only reaches a 401 or 403.
import { Trans } from '@lingui/react/macro'
import { useEffect, type ReactNode } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router'
import { useMe, useSetupStatus } from '../api/queries'
import { ErrorNotice, Loading } from '../components/ui'
import { signedInAs } from '../session/ui'

/** Signed in; the start password may still be pending (only /passwort uses this alone). */
export function RequireSession() {
  const me = useMe()
  const setup = useSetupStatus()
  const location = useLocation()
  const account = me.data?.id
  useEffect(() => {
    if (account !== undefined) signedInAs(account)
  }, [account])
  if (me.isPending) return <Loading />
  if (me.isError) return <ErrorNotice error={me.error} />
  if (me.data === null) {
    if (setup.isPending) return <Loading />
    if (setup.data?.needs_setup) return <Navigate to="/einrichtung" replace />
    const target = location.pathname + location.search
    return <Navigate to={`/anmelden?ziel=${encodeURIComponent(target)}`} replace />
  }
  return <Outlet />
}

/** Signed in and done with the start password (design A4: a mandatory step). */
export function RequireAccount() {
  const me = useMe()
  if (me.data?.must_change_password) return <Navigate to="/passwort" replace />
  return <Outlet />
}

export function RequireAdmin({ children }: { children: ReactNode }) {
  const me = useMe()
  if (me.data?.role !== 'admin')
    return (
      <p role="alert" className="text-sm">
        <Trans>Die Administration steht nur Administratoren offen.</Trans>
      </p>
    )
  return children
}
