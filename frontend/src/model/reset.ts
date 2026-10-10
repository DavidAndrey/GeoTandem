// One reset of all Modus B state this window holds (security review, gate
// E2.4): on sign-out and on sign-in, so the next account sees nothing of the
// last one's. The dialogue and its records, the last model change with its
// snapshot of the analysis, what undo put back, the approval baselines, work
// parked for the editor, the hand-over, the panel and the "Meine
// Modellaktionen" dialog all go. An answer of the last account still on its
// way finds the state reset (``sameGeneration``) and changes nothing.
import { resetApproval } from './approval/flow'
import { useMyActionsDialog } from './log/dialog'
import { resetHandover } from './panel/handover'
import { resetPanel } from './panel/state'
import { useModel } from './store'

export function resetModelState() {
  // First: the reset count makes every answer still on its way a stale one.
  useModel.getState().reset()
  resetApproval()
  resetHandover()
  resetPanel()
  useMyActionsDialog.setState({ open: false })
}
