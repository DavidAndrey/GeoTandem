// Prompt profiles of a measuring point (plan E3, D9): the lists and words are
// the connection form's (``admin/promptProfile.ts``, WP91); here only what a
// run adds: short labels for the selects and column heads, the connection's
// own profile and applying a measured one to it (V6.4).
import { t } from '@lingui/core/macro'
import { api, type ConnectionInfo, type PromptProfile } from '../../api/client'
import {
  DEFAULT_PROMPT_PROFILE,
  EXAMPLE_SETS,
  examplesLabel,
  OUTPUT_MODES,
  outputLabel,
  PLACEMENTS as PLACEMENT_LIST,
  sameProfile as same,
  type ExampleSet,
  type OutputMode,
  type Placement,
} from '../promptProfile'

export type Examples = ExampleSet
export type Output = OutputMode
export type { Placement }

export const DEFAULT_PROFILE = DEFAULT_PROMPT_PROFILE
export const EXAMPLES = EXAMPLE_SETS
export const PLACEMENTS = PLACEMENT_LIST
export const OUTPUTS = OUTPUT_MODES

export const examplesText = examplesLabel
/** "P9": the short name; the connection form explains it in full (``placementLabel``). */
export const placementText = (value: Placement) => ({ P0: t`P0`, P5: t`P5`, P9: t`P9` })[value]
export const outputText = outputLabel

/** "Standard · P0 · erzwungen". */
export const profileText = (p: PromptProfile) =>
  [examplesText(p.examples), placementText(p.placement), outputText(p.output)].join(' · ')

export const sameProfile = same

export const isDefaultProfile = (p: PromptProfile) => sameProfile(p, DEFAULT_PROFILE)

/** The profile the connection uses in operation (D9). */
export const connectionProfile = (connection: ConnectionInfo | undefined): PromptProfile =>
  connection?.prompt_profile ?? DEFAULT_PROFILE

/**
 * Sets the profile on the connection (V6.4) with the connection's PATCH; the
 * server audits it as ``llm_connection_changed`` (O8).
 */
export const applyProfile = (connectionId: number, profile: PromptProfile) =>
  api.admin.updateConnection(connectionId, { prompt_profile: profile, confirm_data_release: false })
