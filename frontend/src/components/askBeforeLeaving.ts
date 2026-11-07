// Unsaved edits on an admin page (Prüffall, Anbindung): ask before leaving.
import { useEffect, type Dispatch, type SetStateAction } from 'react'
import { useNavigate } from 'react-router'

/**
 * While ``dirty``: a click on any link of this application asks first
 * (``ask`` holds where to go), and closing or reloading the tab asks the browser's question.
 * The router is a ``BrowserRouter``, which has no ``useBlocker``; links of the
 * page and of the navigation are caught in the capture phase, before the
 * router follows them. The browser's back button is not caught.
 */
export function useAskBeforeLeaving(
  dirty: boolean,
  ask: Dispatch<SetStateAction<(() => void) | null>>,
) {
  const navigate = useNavigate()
  useEffect(() => {
    if (!dirty) return
    const click = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const target = event.target instanceof Element ? event.target : null
      const anchor = target?.closest('a[href]')
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target === '_blank') return
      const url = new URL(anchor.href, window.location.href)
      if (url.origin !== window.location.origin) return
      event.preventDefault()
      event.stopPropagation()
      const go = () => navigate(url.pathname + url.search + url.hash)
      ask(() => go)
    }
    const unload = (event: BeforeUnloadEvent) => event.preventDefault()
    document.addEventListener('click', click, true)
    window.addEventListener('beforeunload', unload)
    return () => {
      document.removeEventListener('click', click, true)
      window.removeEventListener('beforeunload', unload)
    }
  }, [dirty, ask, navigate])
}
