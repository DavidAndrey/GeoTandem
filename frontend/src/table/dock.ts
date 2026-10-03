// Whether the attribute table is open and how tall: a per-viewer convenience
// (plan E1.6 D7), kept in localStorage, never part of the session.
import { create } from 'zustand'

const KEY = 'geotandem.table-dock'
export const MIN_HEIGHT = 140
const DEFAULT = { open: false, height: 260 }

function stored(): typeof DEFAULT {
  try {
    const raw = localStorage.getItem(KEY)
    const value = raw ? (JSON.parse(raw) as Partial<typeof DEFAULT>) : {}
    return {
      open: typeof value.open === 'boolean' ? value.open : DEFAULT.open,
      height: typeof value.height === 'number' ? value.height : DEFAULT.height,
    }
  } catch {
    return DEFAULT
  }
}

function store(value: typeof DEFAULT) {
  try {
    localStorage.setItem(KEY, JSON.stringify(value))
  } catch {
    // Private window or blocked storage: the dock still works, it just forgets.
  }
}

interface DockStore {
  open: boolean
  height: number
  setOpen: (open: boolean) => void
  setHeight: (height: number) => void
}

export const useDock = create<DockStore>()((set, get) => ({
  ...stored(),
  setOpen: (open) => {
    set({ open })
    store({ open, height: get().height })
  },
  setHeight: (height) => {
    const clamped = Math.round(Math.max(MIN_HEIGHT, height))
    set({ height: clamped })
    store({ open: get().open, height: clamped })
  },
}))
