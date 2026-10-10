// Whether "Meine Modellaktionen" (design M16.3) is open: the user menu opens
// it, and so can an answer's "Protokoll" in the prompt panel.
import { create } from 'zustand'

export const useMyActionsDialog = create<{ open: boolean }>()(() => ({ open: false }))

export const openMyActions = () => useMyActionsDialog.setState({ open: true })
