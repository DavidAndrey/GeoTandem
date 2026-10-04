// Addresses of the workplace (design "Adressen", plan D7): /sitzung/:id opens
// that session with its check; / lands once in the last opened one.
import { t } from '@lingui/core/macro'
import { useEffect } from 'react'
import { useNavigate } from 'react-router'
import { useAnalysis } from '../analysis/store'
import { api, ApiRequestError } from '../api/client'
import { useLayers } from '../api/queries'
import { openSession } from './actions'
import { useSession } from './store'
import { useSessionUi } from './ui'

/** The id being opened, so a re-run effect does not open it twice. */
let opening: string | null = null

export function useSessionRoute(id: string | undefined) {
  const navigate = useNavigate()
  const catalog = useLayers()

  useEffect(() => {
    if (!catalog.data) return
    const ui = useSessionUi.getState()
    if (id) {
      ui.setLanded(true)
      if (id === useSession.getState().current?.id || id === opening) return
      opening = id
      openSession(id, new Set(catalog.data.map((l) => l.name)))
        .catch((error: unknown) =>
          useSession.getState().setReport({
            name: '',
            check: null,
            removed: { layers: [], rows: [], result: false },
            error:
              error instanceof ApiRequestError && error.status === 404
                ? t`Diese Sitzung gibt es nicht oder nicht für dieses Konto.`
                : error instanceof Error
                  ? error.message
                  : String(error),
          }),
        )
        .finally(() => {
          if (opening === id) opening = null
        })
      return
    }
    if (ui.landed) return
    ui.setLanded(true)
    // Only into an empty workplace: work already started is never replaced.
    if (useAnalysis.getState().layers.length > 0) return
    api.sessions
      .last()
      .then((last) => {
        if (last && useAnalysis.getState().layers.length === 0)
          navigate(`/sitzung/${last.id}`, { replace: true })
      })
      .catch(() => undefined)
  }, [id, catalog.data, navigate])
}
